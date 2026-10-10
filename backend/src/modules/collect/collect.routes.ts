import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { pushPrompt, approvePush, declinePush, resolveQrToPush } from './collect.service.js';
import { encodeQr } from './collect.lib.js';
import { prisma } from '../../db/client.js';

function toBig(v: string | number): bigint | null { try { return BigInt(v); } catch { return null; } }

export async function collectRoutes(app: FastifyInstance) {
  // Merchant generates a QR string for one of its pay numbers (optionally with an
  // amount baked in). The customer's Axo scans it and is shown a confirm prompt.
  app.get('/collect/qr', { preHandler: [requireAuth] }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    const kind = q.kind as 'till' | 'paybill';
    if (kind !== 'till' && kind !== 'paybill') return reply.code(400).send({ error: 'kind must be till|paybill' });
    const pn = await prisma.payNumber.findFirst({ where: { merchantId: req.auth!.merchantId, kind, active: true } });
    if (!pn) return reply.code(404).send({ error: 'no_active_number' });
    const amt = q.amountMinor ? toBig(q.amountMinor) ?? undefined : undefined;
    const qr = encodeQr({ kind, number: pn.number, account: q.account, amountMinor: amt ?? undefined, currency: q.currency });
    return reply.send({ qr, number: pn.number });
  });

  // STK-style push: merchant pushes a pay prompt to a customer. No money moves.
  app.post('/collect/push', { preHandler: [requireAuth, requireRole('owner', 'manager', 'cashier', 'accountant')] }, async (req, reply) => {
    const body = z.object({
      targetWaId: z.string().optional(),
      targetTag: z.string().optional(),
      amountMinor: z.union([z.string(), z.number()]),
      currency: z.string().length(3),
      account: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const key = req.headers['idempotency-key'] as string | undefined;
    const amt = toBig(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    try {
      const p = await pushPrompt({ merchantId: req.auth!.merchantId, ...body.data, amountMinor: amt, idempotencyKey: key });
      return reply.code(201).send(JSON.parse(JSON.stringify(p, bigintReplacer)));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // Customer approves / declines a push (the STK confirmation). In production the
  // customer calls this from their own authenticated Axo session; here it is the
  // confirm hook the WhatsApp router and the app both use.
  app.post('/collect/push/:ref/approve', async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const r = await approvePush(ref);
    const code = r.status === 'approved' ? 200 : 409;
    return reply.code(code).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
  });
  app.post('/collect/push/:ref/decline', async (req, reply) => {
    const { ref } = req.params as { ref: string };
    return reply.send(await declinePush(ref));
  });

  // A customer scans a QR → turns into a push prompt they then approve.
  app.post('/collect/scan', { preHandler: [requireAuth] }, async (req, reply) => {
    const body = z.object({ qr: z.string(), customerId: z.string(), amountMinor: z.union([z.string(), z.number()]).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const amt = body.data.amountMinor != null ? toBig(body.data.amountMinor) ?? undefined : undefined;
    const r = await resolveQrToPush({ qr: body.data.qr, scannerCustomerId: body.data.customerId, amountMinor: amt ?? undefined });
    return reply.send(JSON.parse(JSON.stringify(r, bigintReplacer)));
  });
}
