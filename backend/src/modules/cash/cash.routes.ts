import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { applyRampWebhook } from './cash.service.js';
import { rampStatus, allRamps } from '../../providers/ramp.registry.js';
import { prisma } from '../../db/client.js';

export async function cashRoutes(app: FastifyInstance) {
  // Raw body for ramp webhook HMAC is preserved by the global parser in app.ts.

  // Provider connection status (admin/ops, §13).
  app.get('/ramps', { preHandler: [requireAuth, requireRole('owner', 'accountant')] }, async (_req, reply) => {
    return reply.send(rampStatus());
  });

  // Cash-in and cash-out are started by the CUSTOMER (POST /customer/cash/in and
  // /customer/cash/out in customer.routes.ts). They used to be here under any
  // merchant token with the customer named in the body — which let a business's
  // staff withdraw any customer's wallet to any destination.

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
