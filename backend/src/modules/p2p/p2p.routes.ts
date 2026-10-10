import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { payMerchant } from './p2p.service.js';
import { prisma } from '../../db/client.js';

const payBody = z.object({
  customerId: z.string().min(1),
  amountMinor: z.union([z.string(), z.number()]),
  currency: z.string().length(3),
  note: z.string().optional(),
});

export async function p2pRoutes(app: FastifyInstance) {
  // A customer pays THIS business. The merchant is taken from the caller's token
  // (server-authoritative), never from the body. Requires an Idempotency-Key so a
  // retry never double-charges.
  app.post(
    '/payments/customer',
    { preHandler: [requireAuth, requireRole('owner', 'manager', 'cashier', 'accountant')] },
    async (req, reply) => {
      const parsed = payBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const key = req.headers['idempotency-key'] as string | undefined;
      if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });

      let amountMinor: bigint;
      try { amountMinor = BigInt(parsed.data.amountMinor); } catch { return reply.code(400).send({ error: 'bad_amount' }); }

      try {
        const result = await payMerchant({
          customerId: parsed.data.customerId,
          merchantId: req.auth!.merchantId,
          amountMinor,
          currency: parsed.data.currency,
          note: parsed.data.note,
          idempotencyKey: key,
        });
        return reply.code(201).send(JSON.parse(JSON.stringify(result, bigintReplacer)));
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );

  // Admin: list customers (wallet-holders) — operational monitoring (§13).
  app.get('/customers', { preHandler: [requireAuth, requireRole('owner', 'accountant')] }, async (_req, reply) => {
    const rows = await prisma.customer.findMany({
      where: { axoTag: { not: { startsWith: '@axo_clearing' } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { wallet: true },
    });
    return reply.send(JSON.parse(JSON.stringify(rows, bigintReplacer)));
  });
}
