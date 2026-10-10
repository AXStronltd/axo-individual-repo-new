import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../db/client.js';
import { isLive } from '../../config/env.js';
import { requireAuth, requireRole, isApiKeyCaller, hashApiKey } from '../../middleware/auth.js';

/**
 * POS / back-office integration: API keys for machines, and the webhook
 * endpoints payment events are delivered to. Owner-only, and only from a
 * person's session — an API key can't mint more keys or redirect the webhooks.
 */
async function requirePerson(req: FastifyRequest, reply: FastifyReply) {
  if (isApiKeyCaller(req)) return reply.code(403).send({ error: 'requires_staff_login' });
}

const keySchema = z.object({
  name: z.string().min(1).max(60),
  // a machine never gets owner rights
  role: z.enum(['cashier', 'manager']).default('cashier'),
});

const webhookSchema = z.object({ url: z.string().url().max(500) });

export async function integrationRoutes(app: FastifyInstance) {
  const ownerPerson = { preHandler: [requireAuth, requireRole('owner'), requirePerson] };

  /** Create an API key. The full key is returned ONCE; only its hash is stored. */
  app.post('/api-keys', ownerPerson, async (req, reply) => {
    const body = keySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const prefix = randomBytes(6).toString('hex'); // 12 chars
    const key = `axo_sk_${prefix}_${randomBytes(24).toString('base64url')}`;
    const row = await prisma.apiKey.create({
      data: { merchantId: req.auth!.merchantId, name: body.data.name, prefix, keyHash: hashApiKey(key), role: body.data.role, createdById: req.auth!.userId },
    });
    return reply.code(201).send({ id: row.id, name: row.name, role: row.role, prefix: row.prefix, key, createdAt: row.createdAt });
  });

  app.get('/api-keys', ownerPerson, async (req, reply) => {
    const rows = await prisma.apiKey.findMany({ where: { merchantId: req.auth!.merchantId }, orderBy: { createdAt: 'desc' } });
    return reply.send(rows.map((r) => ({ id: r.id, name: r.name, role: r.role, prefix: r.prefix, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt })));
  });

  app.post('/api-keys/:id/revoke', ownerPerson, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await prisma.apiKey.updateMany({ where: { id, merchantId: req.auth!.merchantId, revokedAt: null }, data: { revokedAt: new Date() } });
    return reply.code(r.count ? 200 : 404).send(r.count ? { ok: true } : { error: 'not_found' });
  });

  /** Register a webhook endpoint. The signing secret is returned ONCE. */
  app.post('/webhook-endpoints', ownerPerson, async (req, reply) => {
    const body = webhookSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    // Payment data must not travel in clear text to a live endpoint.
    if (isLive && !body.data.url.startsWith('https://')) return reply.code(400).send({ error: 'https_required' });
    const secret = 'whsec_' + randomBytes(24).toString('base64url');
    const row = await prisma.merchantWebhook.create({ data: { merchantId: req.auth!.merchantId, url: body.data.url, secret } });
    return reply.code(201).send({ id: row.id, url: row.url, secret, active: row.active, createdAt: row.createdAt });
  });

  app.get('/webhook-endpoints', ownerPerson, async (req, reply) => {
    const rows = await prisma.merchantWebhook.findMany({ where: { merchantId: req.auth!.merchantId }, orderBy: { createdAt: 'desc' } });
    return reply.send(rows.map((r) => ({ id: r.id, url: r.url, active: r.active, createdAt: r.createdAt })));
  });

  app.post('/webhook-endpoints/:id/disable', ownerPerson, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await prisma.merchantWebhook.updateMany({ where: { id, merchantId: req.auth!.merchantId }, data: { active: false } });
    return reply.code(r.count ? 200 : 404).send(r.count ? { ok: true } : { error: 'not_found' });
  });

  /** Recent deliveries and their state — for debugging an integration. */
  app.get('/webhook-deliveries', { preHandler: [requireAuth, requireRole('owner', 'manager')] }, async (req, reply) => {
    const rows = await prisma.webhookDelivery.findMany({ where: { merchantId: req.auth!.merchantId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return reply.send(rows.map((r) => ({ id: r.id, event: r.event, status: r.status, attempts: r.attempts, lastError: r.lastError, createdAt: r.createdAt, deliveredAt: r.deliveredAt, nextAttemptAt: r.nextAttemptAt })));
  });
}
