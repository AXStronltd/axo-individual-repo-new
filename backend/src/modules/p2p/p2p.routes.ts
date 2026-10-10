import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { prisma } from '../../db/client.js';
import { CLEARING_TAG_PREFIX } from './p2p.lib.js';

export async function p2pRoutes(app: FastifyInstance) {
  // A customer pays a business from their OWN session: POST
  // /customer/payments/by-number or /customer/payment-requests/:ref/pay. A
  // merchant-side "charge this customerId" route used to live here; it let any
  // cashier at any business debit any wallet without the customer's PIN.

  // Admin: list customers (wallet-holders) — operational monitoring (§13).
  app.get('/customers', { preHandler: [requireAuth, requireRole('owner', 'accountant')] }, async (_req, reply) => {
    const rows = await prisma.customer.findMany({
      where: { axoTag: { not: { startsWith: CLEARING_TAG_PREFIX } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { wallet: true },
    });
    return reply.send(JSON.parse(JSON.stringify(rows, bigintReplacer)));
  });
}
