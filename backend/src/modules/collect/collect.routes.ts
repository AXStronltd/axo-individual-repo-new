import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import {
  createPaymentRequest,
  cancelPaymentRequest,
  readPaymentRequest,
  serializeRequest,
} from './collect.service.js';
import { encodeQr } from './collect.lib.js';
import { qrSvg } from './qr.svg.js';
import { prisma } from '../../db/client.js';

function toBig(v: string | number): bigint | null { try { return BigInt(v); } catch { return null; } }
const json = (v: unknown) => JSON.parse(JSON.stringify(v, bigintReplacer));

const createSchema = z.object({
  amountMinor: z.union([z.string(), z.number()]),
  currency: z.string().length(3).optional(),
  saleRef: z.string().min(1).max(64).optional(),
  description: z.string().max(140).optional(),
  account: z.string().max(32).optional(),
  // target a specific customer (STK-style push); omit for an open QR / POS request
  customerTag: z.string().optional(),
  customerWaId: z.string().optional(),
  ttlSeconds: z.number().int().min(60).max(86_400).optional(),
});

const REJECT_STATUS: Record<string, number> = {
  bad_amount: 400, currency_not_accepted: 400, unknown_customer: 404,
  sale_ref_conflict: 409, idempotency_key_conflict: 409, business_not_active: 409, unknown_merchant: 404,
};

// Merchant / POS side of collections. Every money movement is approved by the
// CUSTOMER from their own session (customer.routes.ts) — nothing here can charge
// anyone.
export async function collectRoutes(app: FastifyInstance) {
  // A static QR for one of the merchant's pay numbers (optionally with an amount
  // baked in). The customer's app scans it and shows a confirm screen.
  app.get('/collect/qr', { preHandler: [requireAuth] }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    const kind = q.kind as 'till' | 'paybill';
    if (kind !== 'till' && kind !== 'paybill') return reply.code(400).send({ error: 'kind must be till|paybill' });
    const pn = await prisma.payNumber.findFirst({ where: { merchantId: req.auth!.merchantId, kind, active: true } });
    if (!pn) return reply.code(404).send({ error: 'no_active_number' });
    const amt = q.amountMinor ? toBig(q.amountMinor) ?? undefined : undefined;
    const qr = encodeQr({ kind, number: pn.number, account: q.account, amountMinor: amt ?? undefined, currency: q.currency });
    return reply.send({ qr, number: pn.number, svg: await qrSvg(qr) });
  });

  /**
   * Raise a payment request for a sale. Open (shown as a QR at the till / on the
   * POS screen) or targeted at one customer (pushed to their WhatsApp for PIN
   * approval). Re-sending the same saleRef returns the same request.
   */
  app.post('/payment-requests', { preHandler: [requireAuth, requireRole('owner', 'manager', 'cashier')] }, async (req, reply) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', detail: body.error.issues });
    const amt = toBig(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    const key = (req.headers['idempotency-key'] as string | undefined)?.trim();

    const r = await createPaymentRequest({
      merchantId: req.auth!.merchantId,
      createdById: req.auth!.userId,
      amountMinor: amt,
      currency: body.data.currency,
      saleRef: body.data.saleRef,
      description: body.data.description,
      account: body.data.account,
      targetTag: body.data.customerTag,
      targetWaId: body.data.customerWaId,
      ttlSeconds: body.data.ttlSeconds,
      // scoped to the merchant so two businesses' keys can never collide
      idempotencyKey: key ? `${req.auth!.merchantId}:${key}` : undefined,
    });
    if (r.status === 'rejected') return reply.code(REJECT_STATUS[r.reason] ?? 409).send({ error: r.reason });
    return reply.code(r.status === 'created' ? 201 : 200).send(json(serializeRequest(r.request)));
  });

  // Back-compat alias for the original STK-style push: a targeted request.
  app.post('/collect/push', { preHandler: [requireAuth, requireRole('owner', 'manager', 'cashier')] }, async (req, reply) => {
    const body = z.object({
      targetWaId: z.string().optional(),
      targetTag: z.string().optional(),
      amountMinor: z.union([z.string(), z.number()]),
      currency: z.string().length(3),
      account: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    if (!body.data.targetWaId && !body.data.targetTag) return reply.code(400).send({ error: 'target_required' });
    const amt = toBig(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    const key = (req.headers['idempotency-key'] as string | undefined)?.trim();
    const r = await createPaymentRequest({
      merchantId: req.auth!.merchantId, createdById: req.auth!.userId, amountMinor: amt, currency: body.data.currency,
      account: body.data.account, targetTag: body.data.targetTag, targetWaId: body.data.targetWaId,
      idempotencyKey: key ? `${req.auth!.merchantId}:${key}` : undefined,
    });
    if (r.status === 'rejected') return reply.code(REJECT_STATUS[r.reason] ?? 409).send({ error: r.reason });
    return reply.code(r.status === 'created' ? 201 : 200).send(json(serializeRequest(r.request)));
  });

  // List the merchant's requests — the till's live view, or a cashier's own.
  app.get('/payment-requests', { preHandler: [requireAuth] }, async (req, reply) => {
    const q = req.query as { status?: string; saleRef?: string; mine?: string };
    const statusMap: Record<string, string> = { paid: 'approved' };
    const rows = await prisma.pushPrompt.findMany({
      where: {
        merchantId: req.auth!.merchantId,
        ...(q.status ? { status: (statusMap[q.status] ?? q.status) as any } : {}),
        ...(q.saleRef ? { saleRef: q.saleRef } : {}),
        // a cashier sees only the requests they raised
        ...(q.mine === 'true' || req.auth!.role === 'cashier' ? { createdById: req.auth!.userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return reply.send(json(rows.map(serializeRequest)));
  });

  // One request — what a POS polls until it reads "paid".
  app.get('/payment-requests/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await readPaymentRequest({ id, merchantId: req.auth!.merchantId });
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (req.auth!.role === 'cashier' && r.createdById !== req.auth!.userId) return reply.code(404).send({ error: 'not_found' });
    return reply.send(json(serializeRequest(r)));
  });

  // The request's QR as a scannable SVG image — for the Hub, a POS screen or a
  // printed receipt. It encodes only the ref; amount and payee come from the server.
  app.get('/payment-requests/:id/qr.svg', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await readPaymentRequest({ id, merchantId: req.auth!.merchantId });
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (req.auth!.role === 'cashier' && r.createdById !== req.auth!.userId) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', 'image/svg+xml').header('cache-control', 'private, max-age=300').send(await qrSvg(serializeRequest(r).qr));
  });

  // Void a pending request (sale cancelled at the till).
  app.post('/payment-requests/:id/cancel', { preHandler: [requireAuth, requireRole('owner', 'manager', 'cashier')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (req.auth!.role === 'cashier') {
      const own = await prisma.pushPrompt.findFirst({ where: { id, merchantId: req.auth!.merchantId, createdById: req.auth!.userId } });
      if (!own) return reply.code(404).send({ error: 'not_found' });
    }
    const r = await cancelPaymentRequest({ id, merchantId: req.auth!.merchantId });
    if (!r.ok) return reply.code(r.reason === 'not_found' ? 404 : 409).send({ error: r.reason });
    return reply.send({ ok: true });
  });
}
