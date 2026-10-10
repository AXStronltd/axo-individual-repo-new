import { prisma } from '../../db/client.js';
import { payMerchant } from '../p2p/p2p.service.js';
import { makePushRef, parseQr, type PayTarget } from './collect.lib.js';
import { makeSender } from '../whatsapp/whatsapp.sender.js';
import { formatMinor } from '../../lib/money.js';

const PUSH_TTL_MS = 2 * 60 * 1000; // a prompt is valid for 2 minutes
const sender = makeSender();

/**
 * STK-style push-to-pay. The merchant pushes a prompt to a customer; the customer
 * approves in their own Axo/WhatsApp. NO money moves here — this only creates a
 * PENDING prompt and notifies the customer. Returns the ref (like a Safaricom
 * CheckoutRequestID) the client can poll or that the approval webhook carries.
 */
export async function pushPrompt(params: {
  merchantId: string;
  targetWaId?: string;      // the customer's WhatsApp number
  targetTag?: string;       // or their @tag
  amountMinor: bigint;
  currency: string;
  account?: string;
  idempotencyKey?: string;
}) {
  if (params.amountMinor <= 0n) throw new Error('amount must be positive');

  if (params.idempotencyKey) {
    const existing = await prisma.pushPrompt.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
    if (existing) return existing;
  }

  // Resolve who to charge (must be an existing Axo customer).
  let customerId: string | undefined;
  let waId = params.targetWaId;
  if (params.targetTag) {
    const tag = params.targetTag.startsWith('@') ? params.targetTag.toLowerCase() : '@' + params.targetTag.toLowerCase();
    const c = await prisma.customer.findUnique({ where: { axoTag: tag }, include: { waLink: true } });
    if (!c) throw new Error('unknown_customer');
    customerId = c.id; waId = c.waLink?.waId ?? waId;
  } else if (params.targetWaId) {
    const link = await prisma.whatsAppLink.findUnique({ where: { waId: params.targetWaId } });
    customerId = link?.customerId;
  }
  if (!customerId) throw new Error('unknown_customer');

  const prompt = await prisma.pushPrompt.create({
    data: {
      ref: makePushRef(),
      merchantId: params.merchantId,
      customerId,
      targetWaId: waId,
      amountMinor: params.amountMinor,
      currency: params.currency,
      account: params.account,
      status: 'pending',
      idempotencyKey: params.idempotencyKey,
      expiresAt: new Date(Date.now() + PUSH_TTL_MS),
    },
  });

  // Notify the customer (the Axo equivalent of the STK prompt popping up).
  if (waId && sender.available) {
    const merchant = await prisma.merchant.findUnique({ where: { id: params.merchantId } });
    await sender.send({
      to: waId,
      body: `💳 ${merchant?.tradingName ?? 'A business'} is requesting ${params.currency} ${formatMinor(params.amountMinor, 0)}${params.account ? ' (a/c ' + params.account + ')' : ''}.\nReply YES to approve or NO to decline.`,
    });
  }
  return prompt;
}

/**
 * Approve a push prompt → run the real payment. This is the only place a push
 * moves money, and it goes through the same server-authoritative payMerchant
 * (ledger, risk, idempotency). Idempotent: an already-approved prompt returns.
 */
export async function approvePush(ref: string) {
  const prompt = await prisma.pushPrompt.findUnique({ where: { ref } });
  if (!prompt) return { status: 'rejected' as const, reason: 'unknown_ref' };
  if (prompt.status === 'approved') return { status: 'approved' as const, promptId: prompt.id };
  if (prompt.status !== 'pending') return { status: 'rejected' as const, reason: 'prompt_' + prompt.status };
  if (prompt.expiresAt.getTime() < Date.now()) {
    await prisma.pushPrompt.update({ where: { id: prompt.id }, data: { status: 'expired' } });
    return { status: 'rejected' as const, reason: 'expired' };
  }
  if (!prompt.customerId) return { status: 'rejected' as const, reason: 'no_customer' };

  const result = await payMerchant({
    customerId: prompt.customerId,
    merchantId: prompt.merchantId,
    amountMinor: prompt.amountMinor,
    currency: prompt.currency,
    note: prompt.account ? `a/c ${prompt.account}` : 'push',
    idempotencyKey: 'push:' + prompt.ref, // ties the payment to this prompt, once
  });
  await prisma.pushPrompt.update({ where: { id: prompt.id }, data: { status: 'approved', resolvedAt: new Date() } });
  return { status: 'approved' as const, promptId: prompt.id, ...result };
}

export async function declinePush(ref: string) {
  const prompt = await prisma.pushPrompt.findUnique({ where: { ref } });
  if (!prompt || prompt.status !== 'pending') return { ok: false };
  await prisma.pushPrompt.update({ where: { id: prompt.id }, data: { status: 'declined', resolvedAt: new Date() } });
  return { ok: true };
}

/**
 * A customer scans a merchant QR. We parse the target and turn it into a push
 * prompt the customer then approves — so scanning never auto-charges; it always
 * ends in an explicit confirmation. `scannerCustomerId` is the paying customer.
 */
export async function resolveQrToPush(params: { qr: string; scannerCustomerId: string; amountMinor?: bigint }) {
  const target = parseQr(params.qr);
  if (!target) return { status: 'rejected' as const, reason: 'bad_qr' };

  // Figure out the merchant + currency the QR points at.
  let merchantId: string | undefined;
  if (target.kind === 'till' || target.kind === 'paybill') {
    const pn = await prisma.payNumber.findUnique({ where: { kind_number: { kind: target.kind, number: target.number! } } });
    if (!pn || !pn.active) return { status: 'rejected' as const, reason: 'unknown_number' };
    merchantId = pn.merchantId;
  } else {
    return { status: 'rejected' as const, reason: 'qr_tag_is_p2p_not_business' };
  }

  const scanner = await prisma.customer.findUnique({ where: { id: params.scannerCustomerId }, include: { waLink: true } });
  if (!scanner) return { status: 'rejected' as const, reason: 'unknown_scanner' };
  const amountMinor = params.amountMinor ?? target.amountMinor;
  if (!amountMinor || amountMinor <= 0n) return { status: 'need_amount' as const };

  const prompt = await pushPrompt({
    merchantId: merchantId!,
    targetWaId: scanner.waLink?.waId,
    targetTag: scanner.axoTag,
    amountMinor,
    currency: target.currency ?? scanner.currency,
    account: target.account,
  });
  return { status: 'pending' as const, prompt };
}
