import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { beginIdempotent, finishIdempotent } from '../../middleware/idempotency.js';
import { bigintReplacer } from '../../lib/money.js';
import {
  createInvoice,
  issueInvoice,
  recordInvoicePayment,
  cancelInvoice,
  invoiceTotalMinor,
  isOverdue,
} from './invoices.service.js';

const createSchema = z.object({
  customerName: z.string().min(1),
  customerPhone: z.string().optional(),
  subtotalMinor: z.union([z.string(), z.number()]),
  taxRate: z.number().min(0).max(100).default(0),
  dueDate: z.string().datetime().optional(),
  issue: z.boolean().default(false),
});

const paySchema = z.object({
  amountMinor: z.union([z.string(), z.number()]),
  method: z.enum(['axo', 'cash', 'bank']).default('axo'),
});

function serialize(inv: any) {
  const total = invoiceTotalMinor(inv.subtotalMinor, inv.taxRate);
  const status = isOverdue(inv) ? 'overdue' : inv.status;
  return JSON.parse(JSON.stringify({ ...inv, totalMinor: total, status }, bigintReplacer));
}

export async function invoiceRoutes(app: FastifyInstance) {
  // Create — managers and accountants and owners can bill; cashiers cannot.
  app.post(
    '/invoices',
    { preHandler: [requireAuth, requireRole('owner', 'manager', 'accountant')] },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const inv = await createInvoice({
        merchantId: req.auth!.merchantId,
        customerName: parsed.data.customerName,
        customerPhone: parsed.data.customerPhone,
        subtotalMinor: BigInt(parsed.data.subtotalMinor),
        taxRate: parsed.data.taxRate,
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : undefined,
        issue: parsed.data.issue,
      });
      return reply.code(201).send(serialize(inv));
    },
  );

  app.post(
    '/invoices/:id/issue',
    { preHandler: [requireAuth, requireRole('owner', 'manager', 'accountant')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const inv = await prisma.invoice.findFirst({ where: { id, merchantId: req.auth!.merchantId } });
      if (!inv) return reply.code(404).send({ error: 'not_found' });
      return reply.send(serialize(await issueInvoice(id)));
    },
  );

  // Record a payment — money-moving, so idempotent.
  app.post(
    '/invoices/:id/payments',
    { preHandler: [requireAuth, requireRole('owner', 'manager', 'accountant', 'cashier')] },
    async (req, reply) => {
      const idem = await beginIdempotent(req, reply, '/invoices/payments');
      if (!idem) return;
      if (idem.replay !== undefined) return reply.send(idem.replay);

      const { id } = req.params as { id: string };
      const inv = await prisma.invoice.findFirst({ where: { id, merchantId: req.auth!.merchantId } });
      if (!inv) return reply.code(404).send({ error: 'not_found' });

      const parsed = paySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      try {
        const result = await recordInvoicePayment({
          invoiceId: id,
          amountMinor: BigInt(parsed.data.amountMinor),
          method: parsed.data.method,
        });
        const body = JSON.parse(JSON.stringify(result, bigintReplacer));
        await finishIdempotent(idem.key, req.auth!.merchantId, '/invoices/payments', body);
        return reply.send(body);
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );

  app.post(
    '/invoices/:id/cancel',
    { preHandler: [requireAuth, requireRole('owner', 'manager', 'accountant')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const inv = await prisma.invoice.findFirst({ where: { id, merchantId: req.auth!.merchantId } });
      if (!inv) return reply.code(404).send({ error: 'not_found' });
      return reply.send(serialize(await cancelInvoice(id)));
    },
  );

  app.get('/invoices', { preHandler: [requireAuth] }, async (req, reply) => {
    const list = await prisma.invoice.findMany({
      where: { merchantId: req.auth!.merchantId },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(list.map(serialize));
  });

  app.get('/invoices/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inv = await prisma.invoice.findFirst({
      where: { id, merchantId: req.auth!.merchantId },
      include: { payments: true },
    });
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    return reply.send(serialize(inv));
  });

  // Transactions list with simple filters.
  app.get('/transactions', { preHandler: [requireAuth] }, async (req, reply) => {
    const q = req.query as { status?: string; type?: string };
    const list = await prisma.transaction.findMany({
      where: {
        merchantId: req.auth!.merchantId,
        ...(q.status ? { status: q.status as any } : {}),
        ...(q.type ? { type: q.type as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return reply.send(JSON.parse(JSON.stringify(list, bigintReplacer)));
  });

  // CSV export of transactions.
  app.get('/transactions/export', { preHandler: [requireAuth] }, async (req, reply) => {
    const list = await prisma.transaction.findMany({
      where: { merchantId: req.auth!.merchantId },
      orderBy: { createdAt: 'desc' },
    });
    const header = 'id,type,status,amountMinor,currency,provider,providerRef,customerRef,createdAt';
    const rows = list.map((t: (typeof list)[number]) =>
      [t.id, t.type, t.status, t.amountMinor.toString(), t.currency, t.provider, t.providerRef ?? '', t.customerRef ?? '', t.createdAt.toISOString()].join(','),
    );
    reply.header('content-type', 'text/csv');
    reply.header('content-disposition', 'attachment; filename="transactions.csv"');
    return reply.send([header, ...rows].join('\n'));
  });
}
