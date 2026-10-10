import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';
import { payMerchantTx } from '../p2p/p2p.service.js';
import { normalizeTag } from '../p2p/p2p.lib.js';
import { encodeQr } from './collect.lib.js';
import { makeSender } from '../whatsapp/whatsapp.sender.js';
import { stageConfirm } from '../whatsapp/confirm.service.js';
import { formatAmount } from '../whatsapp/chat.lib.js';
import { enqueueMerchantEvent } from '../notify/outbox.service.js';

const PUSH_TTL_MS = 2 * 60 * 1000; // a targeted prompt is valid for 2 minutes
const OPEN_TTL_MS = 15 * 60 * 1000; // an open (QR / POS) request, 15 minutes
const sender = makeSender();

/** An unguessable public reference. It is what a QR or link carries, so it must
 *  not be enumerable the way Math.random() output is. */
export function makeRequestRef(): string {
  return 'pr_' + randomBytes(16).toString('base64url');
}

export type CreateRequestResult =
  | { status: 'created' | 'existing'; request: Awaited<ReturnType<typeof prisma.pushPrompt.create>>; qr: string }
  | { status: 'rejected'; reason: string };

/**
 * Raise a payment request for one sale. NO money moves here.
 *
 * - With a target (targetTag / targetWaId) it is an STK-style push: the customer
 *   is messaged and approves with their PIN.
 * - Without one it is OPEN: the till or POS shows its QR and any Axo customer can
 *   pay it — once.
 *
 * `saleRef` is the merchant's own reference for the sale and is unique per
 * merchant, so a POS that retries "create" after a timeout gets the same request
 * back instead of opening a second one for the same sale.
 */
export async function createPaymentRequest(params: {
  merchantId: string;
  createdById?: string;
  amountMinor: bigint;
  currency?: string;
  saleRef?: string;
  description?: string;
  account?: string;
  targetTag?: string;
  targetWaId?: string;
  ttlSeconds?: number;
  idempotencyKey?: string;
}): Promise<CreateRequestResult> {
  if (params.amountMinor <= 0n) return { status: 'rejected', reason: 'bad_amount' };

  const merchant = await prisma.merchant.findUnique({ where: { id: params.merchantId } });
  if (!merchant) return { status: 'rejected', reason: 'unknown_merchant' };
  if (merchant.accountStatus !== 'active') return { status: 'rejected', reason: 'business_not_active' };
  const currency = (params.currency ?? merchant.currency).toUpperCase();
  const balance = await prisma.account.findFirst({ where: { merchantId: merchant.id, type: 'axo_balance', currency } });
  if (!balance) return { status: 'rejected', reason: 'currency_not_accepted' };

  if (params.idempotencyKey) {
    const existing = await prisma.pushPrompt.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
    if (existing) return existingResult(existing, params, merchant.id);
  }
  if (params.saleRef) {
    const existing = await prisma.pushPrompt.findUnique({ where: { merchantId_saleRef: { merchantId: merchant.id, saleRef: params.saleRef } } });
    if (existing) return existingResult(existing, params, merchant.id);
  }

  // Resolve a targeted customer (must already hold an Axo wallet).
  let customerId: string | undefined;
  let waId = params.targetWaId;
  if (params.targetTag) {
    const tag = normalizeTag(params.targetTag);
    const c = tag ? await prisma.customer.findUnique({ where: { axoTag: tag }, include: { waLink: true } }) : null;
    if (!c) return { status: 'rejected', reason: 'unknown_customer' };
    customerId = c.id;
    waId = c.waLink?.waId ?? waId;
  } else if (params.targetWaId) {
    const link = await prisma.whatsAppLink.findUnique({ where: { waId: params.targetWaId } });
    if (!link) return { status: 'rejected', reason: 'unknown_customer' };
    customerId = link.customerId;
  }

  const targeted = !!customerId;
  const ttlMs = params.ttlSeconds ? params.ttlSeconds * 1000 : targeted ? PUSH_TTL_MS : OPEN_TTL_MS;

  let request;
  try {
    request = await prisma.pushPrompt.create({
      data: {
        ref: makeRequestRef(),
        merchantId: merchant.id,
        customerId,
        targetWaId: waId,
        amountMinor: params.amountMinor,
        currency,
        account: params.account,
        saleRef: params.saleRef,
        description: params.description,
        createdById: params.createdById,
        status: 'pending',
        idempotencyKey: params.idempotencyKey,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
  } catch (e) {
    // Lost a race with a concurrent create for the same sale / key.
    if ((e as { code?: string }).code === 'P2002') {
      const existing = params.saleRef
        ? await prisma.pushPrompt.findUnique({ where: { merchantId_saleRef: { merchantId: merchant.id, saleRef: params.saleRef } } })
        : params.idempotencyKey ? await prisma.pushPrompt.findUnique({ where: { idempotencyKey: params.idempotencyKey } }) : null;
      if (existing) return existingResult(existing, params, merchant.id);
    }
    throw e;
  }

  // Targeted: put an "approve with PIN" step in the customer's WhatsApp, through
  // the same confirmation the customer's own payments use — so a push can never
  // be approved with a bare YES once the customer has a PIN.
  if (targeted && waId) {
    const summary = `Pay ${formatAmount(params.amountMinor, currency)} to ${merchant.tradingName}${params.account ? ' (a/c ' + params.account + ')' : ''}${params.description ? ' — ' + params.description : ''}`;
    await stageConfirm({ waId, action: 'approve_push', amountMinor: params.amountMinor, currency, summary, number: request.ref });
    if (sender.available) {
      await sender.send({
        to: waId,
        body: `💳 ${merchant.tradingName} is requesting ${formatAmount(params.amountMinor, currency)}.\nReply with your PIN to pay, or NO to decline.`,
      });
    }
  }

  return { status: 'created', request, qr: requestQr(request.ref) };
}

/** A repeated create for the same sale: same request back, unless the details
 *  differ — then it is a conflict, never a silent second charge. */
function existingResult(existing: any, params: { amountMinor: bigint; currency?: string }, merchantId: string): CreateRequestResult {
  if (existing.merchantId !== merchantId) return { status: 'rejected', reason: 'idempotency_key_conflict' };
  const sameAmount = existing.amountMinor === params.amountMinor && (!params.currency || existing.currency === params.currency.toUpperCase());
  if (!sameAmount) return { status: 'rejected', reason: 'sale_ref_conflict' };
  return { status: 'existing', request: existing, qr: requestQr(existing.ref) };
}

export function requestQr(ref: string): string {
  return encodeQr({ kind: 'request', ref });
}

export type PayRequestResult =
  | { status: 'paid'; requestId: string; ref: string; transferId: string; merchantTransactionId: string | null; merchantId: string; amountMinor: bigint; currency: string; replayed: boolean }
  | { status: 'rejected'; reason: string };

/**
 * Pay a payment request from a customer's wallet — the ONLY place a request
 * moves money. Marking the request paid and posting both ledgers happen in ONE
 * serializable transaction, keyed so that a given request can settle exactly
 * once no matter how many times, or from how many devices, it is submitted.
 *
 * The caller must already have authenticated the customer and checked their PIN.
 */
export async function payPaymentRequest(params: { ref: string; customerId: string }): Promise<PayRequestResult> {
  // Expire lazily, outside the money transaction, so the state sticks.
  const peek = await prisma.pushPrompt.findUnique({ where: { ref: params.ref } });
  if (!peek) return { status: 'rejected', reason: 'unknown_request' };
  if (peek.status === 'pending' && peek.expiresAt.getTime() < Date.now()) {
    await prisma.pushPrompt.updateMany({ where: { id: peek.id, status: 'pending' }, data: { status: 'expired', resolvedAt: new Date() } });
    return { status: 'rejected', reason: 'expired' };
  }

  return inTransaction(async (tx) => {
    const req = await tx.pushPrompt.findUnique({ where: { ref: params.ref } });
    if (!req) return { status: 'rejected' as const, reason: 'unknown_request' };
    if (req.customerId && req.customerId !== params.customerId) return { status: 'rejected' as const, reason: 'unknown_request' };

    if (req.status === 'approved') {
      // Already paid. The payer retrying gets their receipt; anyone else is told
      // it's taken — never a second charge.
      if (req.paidByCustomerId === params.customerId && req.transferId) {
        return paidResult(req, true);
      }
      return { status: 'rejected' as const, reason: 'already_paid' };
    }
    if (req.status !== 'pending') return { status: 'rejected' as const, reason: 'request_' + req.status };

    const payment = await payMerchantTx(tx as PrismaClient, {
      customerId: params.customerId,
      merchantId: req.merchantId,
      amountMinor: req.amountMinor,
      currency: req.currency,
      note: [req.saleRef ? 'sale ' + req.saleRef : null, req.account ? 'a/c ' + req.account : null].filter(Boolean).join(' · ') || undefined,
      // one payment per request, whatever key the client sent
      idempotencyKey: 'request:' + req.id,
      paymentRequest: { id: req.id, ref: req.ref, saleRef: req.saleRef },
    });

    // Compare-and-set: only a still-pending request can become paid. If another
    // submission won the race, this throws and the whole transaction — the
    // ledger postings included — rolls back.
    const won = await tx.pushPrompt.updateMany({
      where: { id: req.id, status: 'pending' },
      data: {
        status: 'approved',
        resolvedAt: new Date(),
        paidByCustomerId: params.customerId,
        transferId: payment.transfer.id,
        merchantTransactionId: payment.merchantTransactionId,
      },
    });
    if (won.count !== 1) throw new Error('payment request was settled concurrently');

    return paidResult({ ...req, transferId: payment.transfer.id, merchantTransactionId: payment.merchantTransactionId }, false);
  });
}

function paidResult(req: any, replayed: boolean): PayRequestResult {
  return {
    status: 'paid',
    requestId: req.id,
    ref: req.ref,
    transferId: req.transferId,
    merchantTransactionId: req.merchantTransactionId ?? null,
    merchantId: req.merchantId,
    amountMinor: req.amountMinor,
    currency: req.currency,
    replayed,
  };
}

/** The targeted customer declines. Open requests can't be declined (just not paid). */
export async function declinePaymentRequest(params: { ref: string; customerId: string }) {
  const r = await prisma.pushPrompt.updateMany({
    where: { ref: params.ref, customerId: params.customerId, status: 'pending' },
    data: { status: 'declined', resolvedAt: new Date() },
  });
  return { ok: r.count === 1 };
}

/** The business withdraws a request it no longer wants paid (sale voided). */
export async function cancelPaymentRequest(params: { id: string; merchantId: string }) {
  return inTransaction(async (tx) => {
    const r = await tx.pushPrompt.updateMany({
      where: { id: params.id, merchantId: params.merchantId, status: 'pending' },
      data: { status: 'cancelled', resolvedAt: new Date() },
    });
    if (r.count !== 1) {
      const req = await tx.pushPrompt.findFirst({ where: { id: params.id, merchantId: params.merchantId } });
      return { ok: false, reason: req ? 'request_' + req.status : 'not_found' };
    }
    const req = await tx.pushPrompt.findUniqueOrThrow({ where: { id: params.id } });
    await enqueueMerchantEvent(tx as PrismaClient, params.merchantId, 'payment_request.cancelled', { requestId: req.id, ref: req.ref, saleRef: req.saleRef });
    return { ok: true };
  });
}

/** Read a request, marking it expired if its time has passed. */
export async function readPaymentRequest(where: { id?: string; ref?: string; merchantId?: string }) {
  const req = where.id
    ? await prisma.pushPrompt.findFirst({ where: { id: where.id, ...(where.merchantId ? { merchantId: where.merchantId } : {}) } })
    : where.ref ? await prisma.pushPrompt.findUnique({ where: { ref: where.ref } }) : null;
  if (!req) return null;
  if (where.merchantId && req.merchantId !== where.merchantId) return null;
  if (req.status === 'pending' && req.expiresAt.getTime() < Date.now()) {
    await prisma.pushPrompt.updateMany({ where: { id: req.id, status: 'pending' }, data: { status: 'expired', resolvedAt: new Date() } });
    return { ...req, status: 'expired' as const };
  }
  return req;
}

/** The public shape of a request, for merchants and POS. */
export function serializeRequest(req: any) {
  return {
    id: req.id,
    ref: req.ref,
    status: req.status === 'approved' ? 'paid' : req.status,
    amountMinor: req.amountMinor,
    currency: req.currency,
    saleRef: req.saleRef ?? null,
    description: req.description ?? null,
    account: req.account ?? null,
    targeted: !!req.customerId,
    qr: requestQr(req.ref),
    createdById: req.createdById ?? null,
    createdAt: req.createdAt,
    expiresAt: req.expiresAt,
    resolvedAt: req.resolvedAt ?? null,
    paidByCustomerId: req.paidByCustomerId ?? null,
    transferId: req.transferId ?? null,
    merchantTransactionId: req.merchantTransactionId ?? null,
  };
}
