import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { prisma } from '../../db/client.js';
import { agentCashIn, agentCashOut, agentFloatTopup } from './agent.service.js';

function toBig(v: string | number): bigint | null { try { return BigInt(v); } catch { return null; } }

// Axo's OWN agent network — the cash on-ramp/off-ramp that needs no telco.
export async function agentRoutes(app: FastifyInstance) {
  // Register an agent (ops/owner).
  app.post('/agents', { preHandler: [requireAuth, requireRole('owner')] }, async (req, reply) => {
    const body = z.object({ code: z.string().min(3), name: z.string().min(1), country: z.string().length(2), currency: z.string().length(3), commissionBps: z.number().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      const a = await prisma.agent.create({ data: body.data });
      return reply.code(201).send(JSON.parse(JSON.stringify(a, bigintReplacer)));
    } catch { return reply.code(409).send({ error: 'agent_code_taken' }); }
  });

  // Agent float top-up.
  app.post('/agents/:code/float', { preHandler: [requireAuth, requireRole('owner', 'accountant')] }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const amt = toBig((req.body as any)?.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    const r = await agentFloatTopup({ agentCode: code, amountMinor: amt });
    return reply.code(201).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
  });

  // Cash-in: customer gives the agent cash → their wallet is credited.
  app.post('/agents/:code/cash-in', { preHandler: [requireAuth] }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const body = z.object({ customerId: z.string(), amountMinor: z.union([z.string(), z.number()]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const key = req.headers['idempotency-key'] as string | undefined;
    const amt = toBig(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    try {
      const r = await agentCashIn({ agentCode: code, customerId: body.data.customerId, amountMinor: amt, idempotencyKey: key });
      return reply.code(201).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // Cash-out: agent pays the customer cash → their wallet is debited.
  app.post('/agents/:code/cash-out', { preHandler: [requireAuth] }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const body = z.object({ customerId: z.string(), amountMinor: z.union([z.string(), z.number()]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const key = req.headers['idempotency-key'] as string | undefined;
    const amt = toBig(body.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    try {
      const r = await agentCashOut({ agentCode: code, customerId: body.data.customerId, amountMinor: amt, idempotencyKey: key });
      return reply.code(201).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // Agent dashboard: float + accrued commission.
  app.get('/agents/:code', { preHandler: [requireAuth] }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const a = await prisma.agent.findUnique({ where: { code }, include: { txns: { orderBy: { createdAt: 'desc' }, take: 20 } } });
    if (!a) return reply.code(404).send({ error: 'not_found' });
    return reply.send(JSON.parse(JSON.stringify(a, bigintReplacer)));
  });
}
