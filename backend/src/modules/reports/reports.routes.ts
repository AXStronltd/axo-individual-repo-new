import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { settlementReport } from './settlement.service.js';

export async function reportRoutes(app: FastifyInstance) {
  // Daily settlement + cross-ledger reconciliation for one UTC day.
  app.get('/reports/settlement', { preHandler: [requireAuth, requireRole('owner', 'manager', 'accountant')] }, async (req, reply) => {
    const q = req.query as { date?: string; currency?: string };
    const date = q.date ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({ error: 'invalid_date' });
    try {
      const r = await settlementReport({ merchantId: req.auth!.merchantId, date, currency: q.currency });
      return reply.send(JSON.parse(JSON.stringify(r, bigintReplacer)));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}
