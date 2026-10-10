import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { prisma } from '../../db/client.js';
import { freezeCustomer, releaseFreeze, resolveCase, addDenylist, openCase } from './risk.service.js';

export async function riskRoutes(app: FastifyInstance) {
  // Open cases queue (compliance/ops, §10/§13).
  app.get('/risk/cases', { preHandler: [requireAuth, requireRole('owner', 'accountant')] }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    const where = q.status ? { status: q.status as any } : {};
    const rows = await prisma.riskCase.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    return reply.send(JSON.parse(JSON.stringify(rows, bigintReplacer)));
  });

  // Freeze a customer account. The operator is taken from the token.
  app.post('/risk/customers/:id/freeze', { preHandler: [requireAuth, requireRole('owner')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const reason = ((req.body as any)?.reason ?? 'manual freeze').toString();
    try {
      const kase = await freezeCustomer({ customerId: id, operatorId: req.auth!.userId, reason });
      return reply.code(201).send(kase);
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // Release a freeze (maker-checker: a different operator than the one who froze).
  app.post('/risk/cases/:caseId/release', { preHandler: [requireAuth, requireRole('owner')] }, async (req, reply) => {
    const { caseId } = req.params as { caseId: string };
    try {
      const r = await releaseFreeze({ caseId, operatorId: req.auth!.userId });
      return reply.send(r);
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // Resolve a transaction case: clear (allow) or confirm (keep blocked).
  app.post('/risk/cases/:caseId/resolve', { preHandler: [requireAuth, requireRole('owner', 'accountant')] }, async (req, reply) => {
    const { caseId } = req.params as { caseId: string };
    const outcome = (req.body as any)?.outcome;
    if (outcome !== 'cleared' && outcome !== 'confirmed') return reply.code(400).send({ error: 'outcome must be cleared|confirmed' });
    try {
      const r = await resolveCase({ caseId, operatorId: req.auth!.userId, outcome });
      return reply.send(r);
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // File a fraud report (opens a case for investigation).
  app.post('/risk/report', { preHandler: [requireAuth] }, async (req, reply) => {
    const body = z.object({ subjectType: z.string(), subjectId: z.string(), reason: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const kase = await openCase({ kind: 'fraud_report', subjectType: body.data.subjectType, subjectId: body.data.subjectId, reason: body.data.reason, openedBy: req.auth!.userId });
    return reply.code(201).send(kase);
  });

  // Add a denylist entry (sanctions/fraud). Owner only.
  app.post('/risk/denylist', { preHandler: [requireAuth, requireRole('owner')] }, async (req, reply) => {
    const body = z.object({ value: z.string().min(1), kind: z.enum(['tag', 'phone', 'account']), reason: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const entry = await addDenylist({ ...body.data, addedBy: req.auth!.userId });
    return reply.code(201).send(entry);
  });
}
