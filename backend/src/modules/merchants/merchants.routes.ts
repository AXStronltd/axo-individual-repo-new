import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../db/client.js';
import { hashSecret } from '../auth/hash.js';
import { requireAuth } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';

const onboardSchema = z.object({
  legalName: z.string().min(1),
  tradingName: z.string().min(1),
  country: z.string().length(2),
  currency: z.string().length(3),
  owner: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(8),
  }),
});

export async function merchantRoutes(app: FastifyInstance) {
  // Public: register a business + its owner user. Creates the axo_balance account.
  app.post('/merchants', async (req, reply) => {
    const parsed = onboardSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues });

    const d = parsed.data;
    const existing = await prisma.user.findUnique({ where: { email: d.owner.email } });
    if (existing) return reply.code(409).send({ error: 'email_taken' });

    const merchant = await prisma.merchant.create({
      data: {
        legalName: d.legalName,
        tradingName: d.tradingName,
        country: d.country,
        currency: d.currency,
        axoId: `AXO-${randomUUID().slice(0, 8).toUpperCase()}`,
        users: {
          create: {
            name: d.owner.name,
            email: d.owner.email,
            phone: d.owner.phone,
            role: 'owner',
            passwordHash: await hashSecret(d.owner.password),
          },
        },
        accounts: {
          create: [
            { type: 'axo_balance', currency: d.currency },
            { type: 'clearing', currency: d.currency },
          ],
        },
      },
      include: { users: true },
    });

    return reply.code(201).send({
      id: merchant.id,
      axoId: merchant.axoId,
      tradingName: merchant.tradingName,
      country: merchant.country,
      currency: merchant.currency,
      ownerEmail: merchant.users[0]?.email,
    });
  });

  // Authenticated: who am I / my business.
  app.get('/merchants/me', { preHandler: [requireAuth] }, async (req, reply) => {
    const merchant = await prisma.merchant.findUnique({
      where: { id: req.auth!.merchantId },
      include: { accounts: true },
    });
    if (!merchant) return reply.code(404).send({ error: 'not_found' });
    return reply.send(JSON.parse(JSON.stringify(merchant, bigintReplacer)));
  });

  app.get('/accounts', { preHandler: [requireAuth] }, async (req, reply) => {
    const accounts = await prisma.account.findMany({ where: { merchantId: req.auth!.merchantId } });
    return reply.send(JSON.parse(JSON.stringify(accounts, bigintReplacer)));
  });
}
