import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { importAndReconcile, resolveMismatch } from './reconciliation.service.js';

const importSchema = z.object({
  records: z.array(
    z.object({
      providerRef: z.string().min(1),
      actualMinor: z.union([z.string(), z.number()]),
      feeMinor: z.union([z.string(), z.number()]).default(0),
    }),
  ),
});

export async function reconciliationRoutes(app: FastifyInstance) {
  // Import a provider settlement file and reconcile. Owner/accountant.
  app.post(
    '/settlements/import',
    { preHandler: [requireAuth, requireRole('owner', 'accountant')] },
    async (req, reply) => {
      const parsed = importSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const records = parsed.data.records.map((r) => ({
        providerRef: r.providerRef,
        actualMinor: BigInt(r.actualMinor),
        feeMinor: BigInt(r.feeMinor),
      }));
      const result = await importAndReconcile(req.auth!.merchantId, records as any);
      return reply.send(JSON.parse(JSON.stringify(result, bigintReplacer)));
    },
  );

  // The current reconciliation view (settlement rows + their status).
  app.get('/reconciliation', { preHandler: [requireAuth] }, async (req, reply) => {
    const rows = await prisma.settlement.findMany({
      where: { merchantId: req.auth!.merchantId },
      orderBy: { importedAt: 'desc' },
    });
    return reply.send(JSON.parse(JSON.stringify(rows, bigintReplacer)));
  });

  // Resolve a mismatch with an adjustment entry.
  app.post(
    '/reconciliation/:id/resolve',
    { preHandler: [requireAuth, requireRole('owner', 'accountant')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const result = await resolveMismatch({ settlementId: id, merchantId: req.auth!.merchantId });
        return reply.send(JSON.parse(JSON.stringify(result, bigintReplacer)));
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );
}
