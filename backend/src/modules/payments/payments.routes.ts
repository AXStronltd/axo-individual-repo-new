import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { beginIdempotent, finishIdempotent } from '../../middleware/idempotency.js';
import { bigintReplacer } from '../../lib/money.js';
import { createCharge, confirmChargeFromWebhook, getProvider } from './payments.service.js';

const chargeSchema = z.object({
  amountMinor: z.union([z.string(), z.number()]),
  currency: z.string().length(3),
  customerRef: z.string().min(1),
  provider: z.string().optional(),
});

export async function paymentRoutes(app: FastifyInstance) {
  // Create a charge — money-moving, so idempotent and role-gated.
  app.post(
    '/charges',
    { preHandler: [requireAuth, requireRole('owner', 'manager', 'cashier', 'accountant')] },
    async (req, reply) => {
      const idem = await beginIdempotent(req, reply, '/charges');
      if (!idem) return; // 400 already sent
      if (idem.replay !== undefined) return reply.send(idem.replay);

      const parsed = chargeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const txn = await createCharge({
        merchantId: req.auth!.merchantId,
        amountMinor: BigInt(parsed.data.amountMinor),
        currency: parsed.data.currency,
        customerRef: parsed.data.customerRef,
        provider: parsed.data.provider,
      });

      const body = JSON.parse(JSON.stringify(txn, bigintReplacer));
      await finishIdempotent(idem.key, req.auth!.merchantId, '/charges', body);
      return reply.send(body);
    },
  );

  app.get(
    '/charges/:id',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const txn = await prisma.transaction.findFirst({
        where: { id, merchantId: req.auth!.merchantId },
      });
      if (!txn) return reply.code(404).send({ error: 'not_found' });
      return reply.send(JSON.parse(JSON.stringify(txn, bigintReplacer)));
    },
  );

  // Inbound provider webhook. Public endpoint; authenticity comes from the
  // signature the provider adapter verifies — never from the caller's session.
  app.post('/webhooks/:provider', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
    }

    const parsed = getProvider(provider).parseWebhook(headers, raw);
    if (!parsed.valid) return reply.code(401).send({ error: 'bad_signature' });

    const result = await confirmChargeFromWebhook({
      eventId: parsed.eventId,
      provider,
      providerRef: parsed.providerRef,
      outcome: parsed.outcome,
    });
    return reply.send(result);
  });
}
