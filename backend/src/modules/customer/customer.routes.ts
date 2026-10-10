import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { requireCustomer } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { normalizeTag } from '../p2p/p2p.lib.js';
import { verifyPin } from '../p2p/pin.service.js';
import { payByNumber, sendP2P } from '../p2p/p2p.service.js';
import { isClearingTag } from '../p2p/p2p.lib.js';
import { notifyCredit } from '../whatsapp/notify.service.js';
import { encodeQr } from '../collect/collect.lib.js';
import { qrSvg } from '../collect/qr.svg.js';
import { sendToUnregistered, refundClaimable } from '../p2p/claim.service.js';
import { reverseTransfer } from '../p2p/reversal.service.js';
import { startCashIn, startCashOut } from '../cash/cash.service.js';
import { agentCashOut } from '../agent/agent.service.js';
import { parseQr } from '../collect/collect.lib.js';
import { payPaymentRequest, declinePaymentRequest, readPaymentRequest } from '../collect/collect.service.js';
import { notifyMerchantPaid } from '../notify/merchant.notify.js';
import type { FastifyReply } from 'fastify';

/**
 * HTTP surface for the INDIVIDUAL wallet app (Axo for Individual).
 *
 * Until now every customer-side route took the customerId from the request body
 * under a *merchant* token, which meant any staff token could move any
 * customer's money. These routes take the customer from the bearer token
 * instead, so the wallet that is debited is always the one that authenticated.
 */

const loginSchema = z.object({
  axoTag: z.string().min(1),
  pin: z.string().min(4).max(6),
});

const resolveSchema = z.object({
  kind: z.enum(['till', 'paybill']),
  number: z.string().min(1),
  account: z.string().optional(),
});

const json = (v: unknown) => JSON.parse(JSON.stringify(v, bigintReplacer));
const amountField = z.union([z.string(), z.number()]);
const pinField = z.string().min(4).max(6);

function toAmount(v: string | number): bigint | null {
  try {
    const n = BigInt(v);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function idempotencyKey(req: { headers: Record<string, unknown> }, customerId: string): string | null {
  const key = (req.headers['idempotency-key'] as string | undefined)?.trim();
  // scoped to the customer so one person's key can never replay another's result
  return key ? `cust:${customerId}:${key}` : null;
}

/**
 * Step-up: re-check the PIN for an action that takes money out of the wallet.
 * Holding a session is not on its own enough to spend. Sends the error reply
 * and returns false when the PIN doesn't pass.
 */
async function stepUp(customerId: string, pin: string, reply: FastifyReply): Promise<boolean> {
  const check = await verifyPin(customerId, pin);
  if (check.ok) return true;
  if (check.reason === 'locked') reply.code(423).send({ error: 'wallet_locked' });
  else if (check.reason === 'no_pin_set') reply.code(409).send({ error: 'no_pin_set' });
  else reply.code(401).send({ error: 'wrong_pin' });
  return false;
}

const paySchema = resolveSchema.extend({
  amountMinor: z.union([z.string(), z.number()]),
  currency: z.string().length(3).optional(),
  pin: z.string().min(4).max(6),
});

export async function customerRoutes(app: FastifyInstance) {
  /**
   * Customer login. The PIN is the credential a wallet-holder already has (the
   * M-Pesa PIN equivalent), verified through the same argon2id + attempt-cap
   * service the WhatsApp flow uses — so five wrong PINs freeze the wallet here
   * exactly as they do there.
   */
  app.post('/customer/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const tag = normalizeTag(parsed.data.axoTag);
    if (!tag) return reply.code(401).send({ error: 'invalid_credentials' });

    const customer = await prisma.customer.findUnique({ where: { axoTag: tag } });
    // Identical response whether the tag is unknown or the PIN is wrong, so the
    // endpoint cannot be used to enumerate who holds an Axo wallet.
    if (!customer) return reply.code(401).send({ error: 'invalid_credentials' });

    const check = await verifyPin(customer.id, parsed.data.pin);
    if (!check.ok) {
      if (check.reason === 'locked') return reply.code(423).send({ error: 'wallet_locked' });
      if (check.reason === 'no_pin_set') return reply.code(409).send({ error: 'no_pin_set' });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const accessToken = await reply.jwtSign({ customerId: customer.id, typ: 'customer' }, { expiresIn: '15m' });
    const refreshToken = await reply.jwtSign(
      { customerId: customer.id, typ: 'customer_refresh' },
      { expiresIn: '30d' },
    );
    return {
      accessToken,
      refreshToken,
      customer: {
        id: customer.id,
        axoTag: customer.axoTag,
        displayName: customer.displayName,
        currency: customer.currency,
      },
    };
  });

  app.post('/customer/auth/refresh', async (req, reply) => {
    const body = z.object({ refreshToken: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      const decoded = app.jwt.verify<{ customerId: string; typ?: string }>(body.data.refreshToken);
      if (decoded.typ !== 'customer_refresh') return reply.code(401).send({ error: 'not_a_refresh_token' });
      const accessToken = await reply.jwtSign({ customerId: decoded.customerId, typ: 'customer' }, { expiresIn: '15m' });
      return { accessToken };
    } catch {
      return reply.code(401).send({ error: 'invalid_refresh' });
    }
  });

  /** The authenticated customer and their real, ledger-backed wallet balance. */
  app.get('/customer/me', { preHandler: [requireCustomer] }, async (req, reply) => {
    const customer = await prisma.customer.findUnique({
      where: { id: req.customer!.customerId },
      include: { wallet: true },
    });
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    const body = {
      id: customer.id,
      axoTag: customer.axoTag,
      displayName: customer.displayName,
      country: customer.country,
      currency: customer.currency,
      status: customer.status,
      kycTier: customer.kycTier,
      wallet: customer.wallet
        ? {
            currency: customer.wallet.currency,
            balanceMinor: customer.wallet.balanceMinor,
            reservedMinor: customer.wallet.reservedMinor,
            spendableMinor: customer.wallet.balanceMinor - customer.wallet.reservedMinor,
          }
        : null,
    };
    return reply.send(JSON.parse(JSON.stringify(body, bigintReplacer)));
  });

  /** The customer's own recent movements — the wallet history screen. */
  app.get('/customer/transfers', { preHandler: [requireCustomer] }, async (req, reply) => {
    const me = req.customer!.customerId;
    const rows = await prisma.p2PTransfer.findMany({
      where: { OR: [{ senderId: me }, { recipientId: me }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const shaped = rows.map((r) => ({
      id: r.id,
      direction: r.senderId === me ? 'out' : 'in',
      amountMinor: r.amountMinor,
      feeMinor: r.feeMinor,
      currency: r.currency,
      status: r.status,
      note: r.note,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    }));
    return reply.send(JSON.parse(JSON.stringify(shaped, bigintReplacer)));
  });

  /**
   * Resolve a Till/Paybill number to the business behind it, so the app can show
   * "Pay to: Java House — Yaya" on the confirm screen before any money moves.
   * Only the trading name and label are returned — never the merchant's id or
   * any other internal detail.
   */
  app.post('/customer/pay-numbers/resolve', { preHandler: [requireCustomer] }, async (req, reply) => {
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const pn = await prisma.payNumber.findUnique({
      where: { kind_number: { kind: parsed.data.kind, number: parsed.data.number.replace(/\s/g, '') } },
      include: { lines: true },
    });
    if (!pn || !pn.active) return reply.code(404).send({ ok: false, reason: 'unknown_or_inactive_number' });
    // PayNumber carries a bare merchantId (no Prisma relation), so the business
    // is a second lookup rather than an include.
    const merchant = await prisma.merchant.findUnique({ where: { id: pn.merchantId } });
    if (!merchant) return reply.code(404).send({ ok: false, reason: 'unknown_or_inactive_number' });
    if (merchant.accountStatus !== 'active') {
      return reply.code(409).send({ ok: false, reason: 'business_not_active' });
    }
    if (parsed.data.kind === 'paybill') {
      const acct = (parsed.data.account ?? '').toUpperCase();
      const line = pn.lines.find((l) => l.account === acct && l.active);
      if (!line) {
        return reply.code(404).send({
          ok: false,
          reason: 'unknown_account_line',
          // the valid lines, so the app can offer them instead of guessing
          accounts: pn.lines.filter((l) => l.active).map((l) => ({ account: l.account, name: l.name })),
        });
      }
    }
    return reply.send({
      ok: true,
      kind: pn.kind,
      number: pn.number,
      label: pn.label,
      merchantName: merchant.tradingName,
      currency: merchant.currency,
    });
  });

  /**
   * Pay a business by its Till/Paybill number from the authenticated wallet.
   *
   * The customer comes from the token, the amount and destination from the body,
   * and the PIN is re-verified here — a payment is a step-up action, so holding
   * a valid session is not on its own enough to spend. Requires an
   * Idempotency-Key: payByNumber keys the underlying transfer on it, so a
   * retried request returns the original payment instead of making a second one.
   */
  app.post('/customer/payments/by-number', { preHandler: [requireCustomer] }, async (req, reply) => {
    const parsed = paySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const key = (req.headers['idempotency-key'] as string | undefined)?.trim();
    if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });

    let amountMinor: bigint;
    try {
      amountMinor = BigInt(parsed.data.amountMinor);
    } catch {
      return reply.code(400).send({ error: 'bad_amount' });
    }
    if (amountMinor <= 0n) return reply.code(400).send({ error: 'bad_amount' });

    const customerId = req.customer!.customerId;
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, include: { wallet: true } });
    if (!customer?.wallet) return reply.code(409).send({ error: 'wallet_missing' });

    const pin = await verifyPin(customerId, parsed.data.pin);
    if (!pin.ok) {
      if (pin.reason === 'locked') return reply.code(423).send({ error: 'wallet_locked' });
      if (pin.reason === 'no_pin_set') return reply.code(409).send({ error: 'no_pin_set' });
      return reply.code(401).send({ error: 'wrong_pin' });
    }

    const currency = parsed.data.currency ?? customer.wallet.currency;

    try {
      const r = await payByNumber({
        customerId,
        kind: parsed.data.kind,
        number: parsed.data.number,
        account: parsed.data.account,
        amountMinor,
        currency,
        idempotencyKey: `cust:${customerId}:${key}`,
      });
      if (r.status === 'rejected') return reply.code(404).send({ error: r.reason });
      if (!r.replayed) await notifyMerchantPaid({ merchantId: r.merchantId, amountMinor: r.transfer.amountMinor, currency: r.transfer.currency, customerId });

      // Read the wallet back AFTER the posting so the receipt shows the real
      // ledger-backed balance, not one the client worked out for itself.
      const wallet = await prisma.customerAccount.findUnique({ where: { customerId } });
      const merchant = await prisma.merchant.findUnique({ where: { id: r.merchantId } });
      const body = {
        status: 'completed',
        transferId: r.transfer.id,
        merchantTransactionId: r.merchantTransactionId,
        merchantName: merchant?.tradingName ?? 'the business',
        amountMinor: r.transfer.amountMinor,
        feeMinor: r.transfer.feeMinor,
        currency: r.transfer.currency,
        completedAt: r.transfer.completedAt,
        balanceMinor: wallet?.balanceMinor ?? 0n,
      };
      return reply.code(201).send(JSON.parse(JSON.stringify(body, bigintReplacer)));
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  // ---------------------------------------------------------------------------
  // Payment requests (QR at a till, a POS sale, or a push from a business)
  // ---------------------------------------------------------------------------

  /** Requests a business has pushed to ME that are waiting for my approval. */
  app.get('/customer/payment-requests', { preHandler: [requireCustomer] }, async (req, reply) => {
    const rows = await prisma.pushPrompt.findMany({
      where: { customerId: req.customer!.customerId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const merchants = await prisma.merchant.findMany({ where: { id: { in: rows.map((r) => r.merchantId) } } });
    const names = new Map(merchants.map((m) => [m.id, m.tradingName]));
    return reply.send(json(rows.map((r) => customerView(r, names.get(r.merchantId)))));
  });

  /**
   * Scan anything: a request QR resolves to that request; a till / paybill QR
   * resolves to the business so the app can show who it is paying. Scanning
   * never charges — the customer still confirms with their PIN.
   */
  app.post('/customer/scan', { preHandler: [requireCustomer] }, async (req, reply) => {
    const body = z.object({ qr: z.string().min(1).max(512) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const target = parseQr(body.data.qr);
    if (!target) return reply.code(400).send({ error: 'bad_qr' });

    if (target.kind === 'request') {
      const r = await readPaymentRequest({ ref: target.ref });
      if (!r || (r.customerId && r.customerId !== req.customer!.customerId)) return reply.code(404).send({ error: 'unknown_request' });
      const m = await prisma.merchant.findUnique({ where: { id: r.merchantId } });
      return reply.send({ kind: 'request', request: json(customerView(r, m?.tradingName)) });
    }
    if (target.kind === 'till' || target.kind === 'paybill') {
      const pn = await prisma.payNumber.findUnique({ where: { kind_number: { kind: target.kind, number: target.number! } } });
      if (!pn || !pn.active) return reply.code(404).send({ error: 'unknown_or_inactive_number' });
      const m = await prisma.merchant.findUnique({ where: { id: pn.merchantId } });
      if (!m || m.accountStatus !== 'active') return reply.code(404).send({ error: 'unknown_or_inactive_number' });
      return reply.send(json({
        kind: target.kind, number: pn.number, account: target.account ?? null, merchantName: m.tradingName,
        amountMinor: target.amountMinor ?? null, currency: target.currency ?? m.currency,
      }));
    }
    return reply.send({ kind: 'tag', tag: target.tag });
  });

  /** One request, by the ref its QR / link carries. */
  app.get('/customer/payment-requests/:ref', { preHandler: [requireCustomer] }, async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const r = await readPaymentRequest({ ref });
    if (!r || (r.customerId && r.customerId !== req.customer!.customerId)) return reply.code(404).send({ error: 'unknown_request' });
    const m = await prisma.merchant.findUnique({ where: { id: r.merchantId } });
    return reply.send(json(customerView(r, m?.tradingName)));
  });

  /**
   * Pay a request. PIN step-up, then the request settles exactly once: a retry
   * by the same customer returns the original receipt; anyone else is refused.
   */
  app.post('/customer/payment-requests/:ref/pay', { preHandler: [requireCustomer] }, async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const body = z.object({ pin: pinField }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const customerId = req.customer!.customerId;
    if (!(await stepUp(customerId, body.data.pin, reply))) return;

    try {
      const r = await payPaymentRequest({ ref, customerId });
      if (r.status === 'rejected') {
        const code = r.reason === 'unknown_request' ? 404 : 409;
        return reply.code(code).send({ error: r.reason });
      }
      if (!r.replayed) await notifyMerchantPaid({ merchantId: r.merchantId, amountMinor: r.amountMinor, currency: r.currency, customerId, requestId: r.requestId });
      const wallet = await prisma.customerAccount.findUnique({ where: { customerId } });
      const m = await prisma.merchant.findUnique({ where: { id: r.merchantId } });
      return reply.code(r.replayed ? 200 : 201).send(json({
        status: 'paid', replayed: r.replayed, ref: r.ref, transferId: r.transferId, merchantTransactionId: r.merchantTransactionId,
        merchantName: m?.tradingName ?? 'the business', amountMinor: r.amountMinor, currency: r.currency,
        balanceMinor: wallet?.balanceMinor ?? 0n,
      }));
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  /** Decline a request that was pushed to me. */
  app.post('/customer/payment-requests/:ref/decline', { preHandler: [requireCustomer] }, async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const r = await declinePaymentRequest({ ref, customerId: req.customer!.customerId });
    return reply.code(r.ok ? 200 : 409).send(r.ok ? { ok: true } : { error: 'not_pending' });
  });

  // ---------------------------------------------------------------------------
  // Customer-initiated money actions that used to take a customerId in the body
  // under a merchant token. The wallet is now always the token's own.
  // ---------------------------------------------------------------------------

  /**
   * Send to another Axo wallet by its @tag — the everyday "send money". Same
   * server-authoritative sendP2P the WhatsApp SEND uses (limits, risk screen,
   * balanced customer ledger), with a PIN step-up and a required Idempotency-Key
   * so a double-tap or a retry never sends twice.
   */
  app.post('/customer/transfers', { preHandler: [requireCustomer] }, async (req, reply) => {
    const body = z.object({ toTag: z.string().min(2).max(40), amountMinor: amountField, note: z.string().max(140).optional(), pin: pinField }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const customerId = req.customer!.customerId;
    const key = idempotencyKey(req, customerId);
    if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const amt = toAmount(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });

    const tag = normalizeTag(body.data.toTag);
    const recipient = tag && !isClearingTag(tag) ? await prisma.customer.findUnique({ where: { axoTag: tag } }) : null;
    if (!recipient) return reply.code(404).send({ error: 'recipient_not_found' });
    if (recipient.id === customerId) return reply.code(409).send({ error: 'cannot send to yourself' });

    if (!(await stepUp(customerId, body.data.pin, reply))) return;
    const wallet = await prisma.customerAccount.findUnique({ where: { customerId } });
    if (!wallet) return reply.code(409).send({ error: 'wallet_missing' });

    try {
      const existing = await prisma.p2PTransfer.findUnique({ where: { idempotencyKey: key } });
      const xfer = await sendP2P({ senderId: customerId, recipientId: recipient.id, amountMinor: amt, currency: wallet.currency, note: body.data.note, idempotencyKey: key });
      const me = await prisma.customer.findUnique({ where: { id: customerId } });
      if (!existing) await notifyCredit({ customerId: recipient.id, amountMinor: xfer.amountMinor, currency: xfer.currency, from: me?.axoTag ?? 'an Axo user', kind: 'payment' });
      const after = await prisma.customerAccount.findUnique({ where: { customerId } });
      return reply.code(existing ? 200 : 201).send(json({
        status: xfer.status, replayed: !!existing, transferId: xfer.id, to: recipient.axoTag, toName: recipient.displayName,
        amountMinor: xfer.amountMinor, feeMinor: xfer.feeMinor, currency: xfer.currency, balanceMinor: after?.balanceMinor ?? 0n,
      }));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  /** My "pay me" QR: encodes only my @tag; the payer still confirms amount and PIN. */
  app.get('/customer/receive-qr.svg', { preHandler: [requireCustomer] }, async (req, reply) => {
    const me = await prisma.customer.findUnique({ where: { id: req.customer!.customerId } });
    if (!me) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', 'image/svg+xml').header('cache-control', 'private, max-age=300')
      .send(await qrSvg(encodeQr({ kind: 'tag', tag: me.axoTag })));
  });

  /** Send to a phone number (registered or not). Reserves funds until claimed. */
  app.post('/customer/transfers/to-phone', { preHandler: [requireCustomer] }, async (req, reply) => {
    const body = z.object({ recipientPhone: z.string().min(6), amountMinor: amountField, note: z.string().max(140).optional(), pin: pinField }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const customerId = req.customer!.customerId;
    const key = idempotencyKey(req, customerId);
    if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const amt = toAmount(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    if (!(await stepUp(customerId, body.data.pin, reply))) return;
    const wallet = await prisma.customerAccount.findUnique({ where: { customerId } });
    if (!wallet) return reply.code(409).send({ error: 'wallet_missing' });
    try {
      const ct = await sendToUnregistered({ senderId: customerId, recipientPhone: body.data.recipientPhone, amountMinor: amt, currency: wallet.currency, note: body.data.note, idempotencyKey: key });
      return reply.code(201).send(json(ct));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  /** Recall one of MY unclaimed sends. */
  app.post('/customer/claims/:code/recall', { preHandler: [requireCustomer] }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const r = await refundClaimable({ code, by: 'sender', senderId: req.customer!.customerId });
    return reply.code(r.ok ? 200 : 409).send(r);
  });

  /** Reverse one of MY person-to-person sends within the window. */
  app.post('/customer/transfers/:id/reverse', { preHandler: [requireCustomer] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ pin: pinField }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    if (!(await stepUp(req.customer!.customerId, body.data.pin, reply))) return;
    try {
      const r = await reverseTransfer({ transferId: id, byCustomerId: req.customer!.customerId });
      return reply.send(json(r));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  /** Fund MY wallet from an external rail. Money only lands on the rail's verified webhook. */
  app.post('/customer/cash/in', { preHandler: [requireCustomer] }, async (req, reply) => {
    const body = z.object({ amountMinor: amountField, source: z.string().min(1), provider: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const customerId = req.customer!.customerId;
    const key = idempotencyKey(req, customerId);
    if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const amt = toAmount(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    const wallet = await prisma.customerAccount.findUnique({ where: { customerId } });
    if (!wallet) return reply.code(409).send({ error: 'wallet_missing' });
    try {
      const r = await startCashIn({ customerId, amountMinor: amt, currency: wallet.currency, source: body.data.source, idempotencyKey: key, providerName: body.data.provider });
      if (r.status === 'unavailable') return reply.code(503).send({ error: 'ramp_unavailable', reason: r.reason });
      return reply.code(201).send(json(r));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  /** Withdraw from MY wallet to an external rail. PIN step-up; funds reserved until the rail confirms. */
  app.post('/customer/cash/out', { preHandler: [requireCustomer] }, async (req, reply) => {
    const body = z.object({ amountMinor: amountField, destination: z.string().min(1), provider: z.string().optional(), pin: pinField }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const customerId = req.customer!.customerId;
    const key = idempotencyKey(req, customerId);
    if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const amt = toAmount(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    if (!(await stepUp(customerId, body.data.pin, reply))) return;
    const wallet = await prisma.customerAccount.findUnique({ where: { customerId } });
    if (!wallet) return reply.code(409).send({ error: 'wallet_missing' });
    try {
      const r = await startCashOut({ customerId, amountMinor: amt, currency: wallet.currency, destination: body.data.destination, idempotencyKey: key, providerName: body.data.provider });
      if (r.status === 'unavailable') return reply.code(503).send({ error: 'ramp_unavailable', reason: r.reason });
      return reply.code(201).send(json(r));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  /** Withdraw cash at an agent: I authorise the debit of MY wallet with my PIN. */
  app.post('/customer/agents/:code/withdraw', { preHandler: [requireCustomer] }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const body = z.object({ amountMinor: amountField, pin: pinField }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const customerId = req.customer!.customerId;
    const key = idempotencyKey(req, customerId);
    if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const amt = toAmount(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    if (!(await stepUp(customerId, body.data.pin, reply))) return;
    try {
      const r = await agentCashOut({ agentCode: code, customerId, amountMinor: amt, idempotencyKey: key });
      return reply.code(201).send(json(r));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
}

/** What a customer may see of a request: who is asking, how much, its state. */
function customerView(r: any, merchantName?: string) {
  return {
    ref: r.ref,
    status: r.status === 'approved' ? 'paid' : r.status,
    merchantName: merchantName ?? 'a business',
    amountMinor: r.amountMinor,
    currency: r.currency,
    description: r.description ?? null,
    saleRef: r.saleRef ?? null,
    account: r.account ?? null,
    expiresAt: r.expiresAt,
  };
}
