import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { sendToUnregistered, claimTransfer, claimByIdentity, repointClaimsToNewNumber, refundClaimable } from './claim.service.js';
import { reverseTransfer } from './reversal.service.js';
import { requireRole } from '../../middleware/auth.js';
import { businessPayCustomer } from './p2p.service.js';
import { notifyCredit } from '../whatsapp/notify.service.js';

function toBig(v: string | number): bigint | null { try { return BigInt(v); } catch { return null; } }

// HTTP surface for the Phase 10 customer features. The WhatsApp router is the
// primary path; these let the app and ops drive the same services.
export async function extrasRoutes(app: FastifyInstance) {
  // Send to a phone (registered or not). Reserves funds; recipient claims.
  app.post('/transfers/to-phone', { preHandler: [requireAuth] }, async (req, reply) => {
    const body = z.object({ senderId: z.string(), recipientPhone: z.string(), amountMinor: z.union([z.string(), z.number()]), currency: z.string().length(3), note: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const key = req.headers['idempotency-key'] as string | undefined;
    const amt = toBig(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    try {
      const ct = await sendToUnregistered({ ...body.data, amountMinor: amt, idempotencyKey: key });
      return reply.code(201).send(JSON.parse(JSON.stringify(ct, bigintReplacer)));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // A BUSINESS pays an individual's Axo wallet (refund, staff/supplier pay) and
  // the customer is NOTIFIED on WhatsApp — the symmetric counterpart to a
  // customer paying a business. merchant is from the token, never the body.
  app.post('/payments/to-customer', { preHandler: [requireAuth, requireRole('owner', 'manager', 'accountant')] }, async (req, reply) => {
    const body = z.object({ customerId: z.string(), amountMinor: z.union([z.string(), z.number()]), currency: z.string().length(3), note: z.string().optional(), kind: z.enum(['payout', 'refund', 'payment']).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const amt = toBig(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    try {
      const r: any = await businessPayCustomer({ merchantId: req.auth!.merchantId, customerId: body.data.customerId, amountMinor: amt, currency: body.data.currency, note: body.data.note, kind: body.data.kind, idempotencyKey: key });
      // notify the recipient on WhatsApp (best-effort; never blocks the money)
      await notifyCredit({ customerId: r.customerId ?? body.data.customerId, amountMinor: amt, currency: body.data.currency, from: r.from ?? 'a business', kind: (r.kind ?? body.data.kind ?? 'payment') });
      return reply.code(201).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // Claim a send (recipient).
  app.post('/claims/:code/claim', async (req, reply) => {
    const { code } = req.params as { code: string };
    const waId = (req.body as any)?.recipientWaId;
    if (!waId) return reply.code(400).send({ error: 'recipientWaId required' });
    const r = await claimTransfer({ code, recipientWaId: waId });
    return reply.code(r.status === 'claimed' ? 200 : 409).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
  });

  // Claim a send by VERIFIED IDENTITY (lost phone / recovered to a new number).
  // The customerId MUST have already passed identity verification (the WhatsApp
  // recovery flow, or ops after manual review) before this is called — identity
  // is the authority, so no match to the original recipient number is required.
  app.post('/claims/:code/claim-by-identity', { preHandler: [requireAuth] }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const customerId = (req.body as any)?.customerId;
    if (!customerId) return reply.code(400).send({ error: 'customerId required' });
    const r = await claimByIdentity({ code, customerId });
    return reply.code(r.status === 'claimed' ? 200 : 409).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
  });

  // Re-point pending (unclaimed) money from an old number to a new one, after a
  // recovery / number change. Identity is proven by requireAuth.
  app.post('/claims/repoint', { preHandler: [requireAuth] }, async (req, reply) => {
    const body = z.object({ oldWaId: z.string(), newWaId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      const r = await repointClaimsToNewNumber(body.data);
      return reply.send(r);
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  // Recall an unclaimed send (sender).
  app.post('/claims/:code/recall', { preHandler: [requireAuth] }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const r = await refundClaimable({ code, by: 'sender' });
    return reply.code(r.ok ? 200 : 409).send(r);
  });

  // Reverse a completed Axo-to-Axo transfer (within the window).
  app.post('/transfers/:id/reverse', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const byCustomerId = (req.body as any)?.byCustomerId;
    if (!byCustomerId) return reply.code(400).send({ error: 'byCustomerId required' });
    try {
      const r = await reverseTransfer({ transferId: id, byCustomerId });
      return reply.send(JSON.parse(JSON.stringify(r, bigintReplacer)));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
}
