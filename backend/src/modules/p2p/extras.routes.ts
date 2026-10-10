import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requireOps } from '../../middleware/ops.js';
import { bigintReplacer } from '../../lib/money.js';
import { claimTransfer, claimByIdentity, repointClaimsToNewNumber } from './claim.service.js';
import { businessPayCustomer } from './p2p.service.js';
import { notifyCredit } from '../whatsapp/notify.service.js';

function toBig(v: string | number): bigint | null { try { return BigInt(v); } catch { return null; } }

// HTTP surface for the Phase 10 features.
//
// Customer-initiated actions (send to a phone, recall, reverse) live in
// customer.routes.ts under a CUSTOMER token + PIN. They used to be here under any
// merchant token with the customer named in the body, which let any business's
// staff move any customer's money.
export async function extrasRoutes(app: FastifyInstance) {
  // A BUSINESS pays an individual's Axo wallet (refund, staff/supplier pay) and
  // the customer is NOTIFIED on WhatsApp — the symmetric counterpart to a
  // customer paying a business. merchant is from the token, never the body, and
  // the money comes from the merchant's own balance.
  app.post('/payments/to-customer', { preHandler: [requireAuth, requireRole('owner', 'manager', 'accountant')] }, async (req, reply) => {
    const body = z.object({ customerId: z.string(), amountMinor: z.union([z.string(), z.number()]), currency: z.string().length(3), note: z.string().optional(), kind: z.enum(['payout', 'refund', 'payment']).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const amt = toBig(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    try {
      const r: any = await businessPayCustomer({ merchantId: req.auth!.merchantId, customerId: body.data.customerId, amountMinor: amt, currency: body.data.currency, note: body.data.note, kind: body.data.kind, idempotencyKey: `${req.auth!.merchantId}:${key}` });
      // notify the recipient on WhatsApp (best-effort; never blocks the money)
      await notifyCredit({ customerId: r.customerId ?? body.data.customerId, amountMinor: amt, currency: body.data.currency, from: r.from ?? 'a business', kind: (r.kind ?? body.data.kind ?? 'payment') });
      return reply.code(201).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // OPS: settle a claim to the number it was addressed to. The normal path is the
  // recipient replying CLAIM on WhatsApp, which proves they hold the number; this
  // is the operator fallback.
  app.post('/claims/:code/claim', { preHandler: [requireOps] }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const waId = (req.body as any)?.recipientWaId;
    if (!waId) return reply.code(400).send({ error: 'recipientWaId required' });
    const r = await claimTransfer({ code, recipientWaId: waId });
    return reply.code(r.status === 'claimed' ? 200 : 409).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
  });

  // OPS: claim a send by VERIFIED IDENTITY (lost phone / recovered to a new
  // number). The customerId MUST have passed identity verification first — that
  // judgement belongs to an operator, never to a merchant.
  app.post('/claims/:code/claim-by-identity', { preHandler: [requireOps] }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const customerId = (req.body as any)?.customerId;
    if (!customerId) return reply.code(400).send({ error: 'customerId required' });
    const r = await claimByIdentity({ code, customerId });
    return reply.code(r.status === 'claimed' ? 200 : 409).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
  });

  // OPS: re-point pending (unclaimed) money from an old number to a new one,
  // after a recovery / number change has been verified.
  app.post('/claims/repoint', { preHandler: [requireOps] }, async (req, reply) => {
    const body = z.object({ oldWaId: z.string(), newWaId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      const r = await repointClaimsToNewNumber(body.data);
      return reply.send(r);
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
}
