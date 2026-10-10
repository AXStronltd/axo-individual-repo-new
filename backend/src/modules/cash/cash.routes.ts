import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { startCashIn, startCashOut, applyRampWebhook } from './cash.service.js';
import { rampStatus, allRamps } from '../../providers/ramp.registry.js';
import { prisma } from '../../db/client.js';

const inBody = z.object({
  customerId: z.string().min(1),
  amountMinor: z.union([z.string(), z.number()]),
  currency: z.string().length(3),
  source: z.string().min(1),
  provider: z.string().optional(),
});
const outBody = z.object({
  customerId: z.string().min(1),
  amountMinor: z.union([z.string(), z.number()]),
  currency: z.string().length(3),
  destination: z.string().min(1),
  provider: z.string().optional(),
});

function toBig(v: string | number): bigint | null {
  try { return BigInt(v); } catch { return null; }
}

export async function cashRoutes(app: FastifyInstance) {
  // Raw body for ramp webhook HMAC is preserved by the global parser in app.ts.

  // Provider connection status (admin/ops, §13).
  app.get('/ramps', { preHandler: [requireAuth, requireRole('owner', 'accountant')] }, async (_req, reply) => {
    return reply.send(rampStatus());
  });

  // Start a cash-in. Idempotency-Key required. Returns 'unavailable' (not a fake
  // success) when no configured ramp supports the country/currency.
  app.post('/cash/in', { preHandler: [requireAuth, requireRole('owner', 'manager', 'cashier', 'accountant')] }, async (req, reply) => {
    const parsed = inBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const amt = toBig(parsed.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    try {
      const r = await startCashIn({ customerId: parsed.data.customerId, amountMinor: amt, currency: parsed.data.currency, source: parsed.data.source, idempotencyKey: key, providerName: parsed.data.provider });
      if (r.status === 'unavailable') return reply.code(503).send({ error: 'ramp_unavailable', reason: r.reason });
      return reply.code(201).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // Start a cash-out. Funds are reserved immediately; debit applied on webhook.
  app.post('/cash/out', { preHandler: [requireAuth, requireRole('owner', 'manager', 'accountant')] }, async (req, reply) => {
    const parsed = outBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const amt = toBig(parsed.data.amountMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    try {
      const r = await startCashOut({ customerId: parsed.data.customerId, amountMinor: amt, currency: parsed.data.currency, destination: parsed.data.destination, idempotencyKey: key, providerName: parsed.data.provider });
      if (r.status === 'unavailable') return reply.code(503).send({ error: 'ramp_unavailable', reason: r.reason });
      return reply.code(201).send(JSON.parse(JSON.stringify(r, bigintReplacer)));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // Ramp webhook: verify signature via the named provider's adapter, de-dup on
  // the event id, then apply. A request alone never moved money; this does.
  app.post('/webhooks/ramp/:provider', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const ramp = allRamps().find((r) => r.name === provider);
    if (!ramp) return reply.code(404).send({ error: 'unknown_provider' });

    const raw = (req as any).rawBody ?? '';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v);
    const vr = ramp.parseWebhook(headers, raw);
    if (!vr.valid) return reply.code(401).send({ error: 'bad_signature' });

    // De-dup on the provider event id.
    const first = await claimEvent(provider, vr.eventId);
    if (!first) return reply.code(200).send({ duplicate: true });

    const result = await applyRampWebhook({ provider, providerRef: vr.providerRef, op: vr.op, outcome: vr.outcome });
    return reply.code(200).send(JSON.parse(JSON.stringify(result, bigintReplacer)));
  });
}

/** Record a ramp webhook event id; false if we've already seen it. */
async function claimEvent(provider: string, eventId: string): Promise<boolean> {
  if (!eventId) return true; // nothing to de-dup on; applyRampWebhook still guards by status
  try {
    await prisma.webhookEvent.create({ data: { id: `${provider}:${eventId}`, provider } });
    return true;
  } catch {
    return false;
  }
}
