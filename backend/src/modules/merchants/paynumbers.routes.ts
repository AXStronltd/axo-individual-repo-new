import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { prisma } from '../../db/client.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';

/**
 * Till / Paybill issuance — the Axo-issued replacements for an M-Pesa Till and
 * Paybill. Before this, PayNumbers existed only in the seed script, so a
 * business could never actually be given a number to be paid on.
 *
 * Issuance is owner-only: a payment number is the business's public identity for
 * collecting money, so a cashier must not be able to mint one.
 */

const LINE = z.object({
  account: z.string().min(1).max(32),
  name: z.string().max(80).optional(),
});

const createSchema = z.object({
  kind: z.enum(['till', 'paybill', 'payid']),
  label: z.string().max(80).optional(),
  // Optional: callers normally let Axo allocate the number.
  number: z.string().regex(/^\d{5,9}$/).optional(),
  lines: z.array(LINE).max(50).optional(),
});

// Tills are 6 digits, Paybills and Pay-IDs 6 digits in a distinct band, so the
// shape of a number hints at how it is paid — the same convention customers
// already know from M-Pesa.
type PayNumberKind = 'till' | 'paybill' | 'payid';

const BANDS: Record<PayNumberKind, { min: number; max: number }> = {
  till: { min: 100000, max: 999999 },
  paybill: { min: 500000, max: 999999 },
  payid: { min: 700000, max: 999999 },
};

/** Allocate an unused number in the band for this kind. */
async function allocateNumber(kind: PayNumberKind): Promise<string> {
  const band = BANDS[kind];
  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate = String(randomInt(band.min, band.max + 1));
    const clash = await prisma.payNumber.findUnique({ where: { kind_number: { kind, number: candidate } } });
    if (!clash) return candidate;
  }
  throw new Error('could not allocate a free number — the band is exhausted');
}

export async function payNumberRoutes(app: FastifyInstance) {
  /** Issue a Till / Paybill / Pay-ID to the caller's own business. */
  app.post('/paynumbers', { preHandler: [requireAuth, requireRole('owner')] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues });
    const d = parsed.data;
    const merchantId = req.auth!.merchantId;

    // A paybill is paid "number + account", so it is useless without at least
    // one account line. Default to MAIN rather than issuing a dead number.
    const lines = d.kind === 'paybill' && (!d.lines || d.lines.length === 0)
      ? [{ account: 'MAIN', name: 'Main account' }]
      : d.lines ?? [];

    const normalized = lines.map((l) => ({
      account: l.account.toUpperCase().replace(/\s+/g, ''),
      name: l.name,
    }));
    const dupe = normalized.find((l, i) => normalized.findIndex((o) => o.account === l.account) !== i);
    if (dupe) return reply.code(400).send({ error: 'duplicate_account_line', account: dupe.account });

    let number: string;
    try {
      number = d.number ?? (await allocateNumber(d.kind));
    } catch (e) {
      return reply.code(503).send({ error: (e as Error).message });
    }

    try {
      const pn = await prisma.payNumber.create({
        data: {
          merchantId,
          kind: d.kind,
          number,
          label: d.label,
          lines: normalized.length ? { create: normalized } : undefined,
        },
        include: { lines: true },
      });
      return reply.code(201).send(pn);
    } catch (e) {
      // The @@unique([kind, number]) constraint is the authority on collisions —
      // including a number the caller chose that is already taken.
      if ((e as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ error: 'number_taken', number });
      }
      throw e;
    }
  });

  /** The caller's own payment numbers. */
  app.get('/paynumbers', { preHandler: [requireAuth] }, async (req, reply) => {
    const rows = await prisma.payNumber.findMany({
      where: { merchantId: req.auth!.merchantId },
      orderBy: { createdAt: 'asc' },
      include: { lines: true },
    });
    return reply.send(rows);
  });

  /** Add an account line to one of the caller's paybills. */
  app.post('/paynumbers/:id/lines', { preHandler: [requireAuth, requireRole('owner', 'manager')] }, async (req, reply) => {
    const parsed = LINE.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { id } = req.params as { id: string };

    // Scoped to the caller's merchant, so one business cannot add lines to
    // another's paybill by guessing an id.
    const pn = await prisma.payNumber.findFirst({ where: { id, merchantId: req.auth!.merchantId } });
    if (!pn) return reply.code(404).send({ error: 'not_found' });
    if (pn.kind !== 'paybill') return reply.code(409).send({ error: 'only_paybills_have_account_lines' });

    const account = parsed.data.account.toUpperCase().replace(/\s+/g, '');
    try {
      const line = await prisma.payNumberLine.create({
        data: { payNumberId: pn.id, account, name: parsed.data.name },
      });
      return reply.code(201).send(line);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ error: 'account_line_exists', account });
      }
      throw e;
    }
  });

  /** Activate / pause a payment number or one of its lines. */
  app.patch('/paynumbers/:id', { preHandler: [requireAuth, requireRole('owner', 'manager')] }, async (req, reply) => {
    const body = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const { id } = req.params as { id: string };
    const pn = await prisma.payNumber.findFirst({ where: { id, merchantId: req.auth!.merchantId } });
    if (!pn) return reply.code(404).send({ error: 'not_found' });
    const updated = await prisma.payNumber.update({ where: { id }, data: { active: body.data.active } });
    return reply.send(updated);
  });
}
