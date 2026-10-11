import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { applyRampWebhook } from './cash.service.js';
import { rampStatus, allRamps } from '../../providers/ramp.registry.js';
import { prisma } from '../../db/client.js';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { requireOps } from '../../middleware/ops.js';
import { verifyBankSignature } from './bank.lib.js';
import { cancelBankDepositIntent, confirmBankDeposit } from './bank.service.js';
import { notifyCredit } from '../whatsapp/notify.service.js';

const json = (v: unknown) => JSON.parse(JSON.stringify(v, bigintReplacer));
const depositBody = z.object({
  amountMinor: z.union([z.string().regex(/^\d+$/), z.number().int()]),
  currency: z.string().length(3),
  bankRef: z.string().min(1).max(128).optional(),
});

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

  // ---- Bank collection (Phase 16) ----------------------------------------
  // Customers create deposit references themselves (/customer/bank-deposits).
  // Only these two paths credit a wallet, and neither is reachable with a
  // merchant or customer token: the collection bank's signed webhook, and a
  // platform operator (X-Ops-Key) matching a line on the bank statement.

  // AUTOMATED: the collection bank reports a received deposit. HMAC-SHA256 over
  // the raw body with BANK_WEBHOOK_SECRET ("X-Axo-Signature: sha256=<hex>"); the
  // bank's own transaction id is required, so a replay can never credit twice.
  app.post('/collections/bank/webhook/:bank', async (req, reply) => {
    const { bank } = req.params as { bank: string };
    const secret = env.BANK_WEBHOOK_SECRET;
    if (!secret) return reply.code(503).send({ error: 'bank_webhook_not_configured' });
    const raw = (req as any).rawBody ?? '';
    if (!verifyBankSignature(raw, String(req.headers['x-axo-signature'] ?? ''), secret)) {
      return reply.code(401).send({ error: 'bad_signature' });
    }
    const body = depositBody.extend({ reference: z.string().min(1).max(64), bankRef: z.string().min(1).max(128) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const r = await confirmBankDeposit({ ...body.data, amountMinor: BigInt(body.data.amountMinor), bank, mode: 'auto' });
    if (r.applied) await notifyBankCredit(r);
    // Already-credited is success from the bank's point of view: stop retrying.
    return reply.code(r.applied || r.reason === 'already_credited' || r.reason === 'bank_ref_already_used' ? 200 : 409).send(json(r));
  });

  // MANUAL: an operator matched a statement line to a reference. Platform-operator only.
  app.post('/collections/bank/:reference/confirm-manual', { preHandler: [requireOps] }, async (req, reply) => {
    const { reference } = req.params as { reference: string };
    const body = depositBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const r = await confirmBankDeposit({ ...body.data, reference, amountMinor: BigInt(body.data.amountMinor), mode: 'manual' });
    if (r.applied) await notifyBankCredit(r);
    return reply.code(r.applied ? 200 : r.reason === 'unknown_reference' ? 404 : 409).send(json(r));
  });

  // An operator voids a reference (e.g. reported as a mistake).
  app.post('/collections/bank/:reference/cancel', { preHandler: [requireOps] }, async (req, reply) => {
    const { reference } = req.params as { reference: string };
    const r = await cancelBankDepositIntent({ reference });
    return reply.code(r.ok ? 200 : r.reason === 'unknown_reference' ? 404 : 409).send(r);
  });
}

async function notifyBankCredit(r: { customerId: string; amountMinor: bigint; currency: string }) {
  await notifyCredit({ customerId: r.customerId, amountMinor: r.amountMinor, currency: r.currency, from: 'Bank transfer', kind: 'cash_in' });
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
