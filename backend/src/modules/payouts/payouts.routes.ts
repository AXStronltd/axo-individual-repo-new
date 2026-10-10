import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { beginIdempotent, finishIdempotent } from '../../middleware/idempotency.js';
import { bigintReplacer } from '../../lib/money.js';
import { createPayout, approveAndExecutePayout, refundPayment } from './payouts.service.js';

const payoutSchema = z.object({
  amountMinor: z.union([z.string(), z.number()]),
  currency: z.string().length(3),
  destination: z.string().min(1),
});

export async function payoutRoutes(app: FastifyInstance) {
  // Maker: create a payout request (owner/accountant). No money moves yet.
  app.post(
    '/payouts',
    { preHandler: [requireAuth, requireRole('owner', 'accountant')] },
    async (req, reply) => {
      const idem = await beginIdempotent(req, reply, '/payouts');
      if (!idem) return;
      if (idem.replay !== undefined) return reply.send(idem.replay);

      const parsed = payoutSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      try {
        const po = await createPayout({
          merchantId: req.auth!.merchantId,
          makerId: req.auth!.userId,
          amountMinor: BigInt(parsed.data.amountMinor),
          currency: parsed.data.currency,
          destination: parsed.data.destination,
        });
        const body = JSON.parse(JSON.stringify(po, bigintReplacer));
        await finishIdempotent(idem.key, req.auth!.merchantId, '/payouts', body);
        return reply.send(body);
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );

  // Checker: approve + execute. Must differ from the maker (owner only).
  app.post(
    '/payouts/:id/approve',
    { preHandler: [requireAuth, requireRole('owner')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const po = await approveAndExecutePayout({
          transactionId: id,
          checkerId: req.auth!.userId,
          merchantId: req.auth!.merchantId,
        });
        return reply.send(JSON.parse(JSON.stringify(po, bigintReplacer)));
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );

  // Refund a confirmed payment — money-moving, idempotent.
  app.post(
    '/transactions/:id/refund',
    { preHandler: [requireAuth, requireRole('owner', 'accountant')] },
    async (req, reply) => {
      const idem = await beginIdempotent(req, reply, '/refund');
      if (!idem) return;
      if (idem.replay !== undefined) return reply.send(idem.replay);
      const { id } = req.params as { id: string };
      try {
        const refund = await refundPayment({ transactionId: id, merchantId: req.auth!.merchantId });
        const body = JSON.parse(JSON.stringify(refund, bigintReplacer));
        await finishIdempotent(idem.key, req.auth!.merchantId, '/refund', body);
        return reply.send(body);
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );
}
