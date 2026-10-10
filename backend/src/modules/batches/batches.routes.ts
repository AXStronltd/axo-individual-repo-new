import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { parseRecipientCsv, validateRecipients, batchTotalMinor } from './batch.lib.js';
import type { Recipient } from './batch.lib.js';
import { createBatch, previewBatch, approveBatch, executeBatch } from './batches.service.js';

const jsonBody = z.object({
  kind: z.enum(['payroll', 'supplier', 'bulk']).default('bulk'),
  currency: z.string().length(3),
  recipients: z
    .array(
      z.object({
        recipient: z.string().min(1),
        destination: z.string().min(1),
        amountMinor: z.union([z.string(), z.number()]),
      }),
    )
    .optional(),
  csv: z.string().optional(),
});

export async function batchRoutes(app: FastifyInstance) {
  // Create a batch from JSON recipients or a CSV. Validates + dedupes first.
  // Maker only (owner/accountant). Returns validation issues without creating
  // the batch if there are hard errors.
  app.post(
    '/batches',
    { preHandler: [requireAuth, requireRole('owner', 'accountant')] },
    async (req, reply) => {
      const parsed = jsonBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      let rows;
      if (parsed.data.csv) {
        rows = parseRecipientCsv(parsed.data.csv).rows;
      } else if (parsed.data.recipients) {
        rows = parsed.data.recipients.map((r, i) => ({
          line: i + 1,
          recipient: r.recipient,
          destination: r.destination,
          amountMinor: (() => {
            try {
              return BigInt(r.amountMinor);
            } catch {
              return undefined;
            }
          })(),
        }));
      } else {
        return reply.code(400).send({ error: 'provide recipients or csv' });
      }

      const validation = validateRecipients(rows);
      if (validation.valid.length === 0) {
        return reply.code(422).send({
          error: 'no_valid_recipients',
          errors: validation.errors,
        });
      }

      const batch = await createBatch({
        merchantId: req.auth!.merchantId,
        makerId: req.auth!.userId,
        kind: parsed.data.kind,
        currency: parsed.data.currency,
        recipients: validation.valid,
      });

      const body = JSON.parse(
        JSON.stringify(
          {
            batch,
            totalMinor: batchTotalMinor(validation.valid),
            validCount: validation.valid.length,
            errors: validation.errors,
            duplicates: validation.duplicates,
          },
          bigintReplacer,
        ),
      );
      return reply.code(201).send(body);
    },
  );

  app.get('/batches/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const preview = await previewBatch(id, req.auth!.merchantId);
      return reply.send(JSON.parse(JSON.stringify(preview, bigintReplacer)));
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  // Checker approves (owner only, must differ from maker).
  app.post(
    '/batches/:id/approve',
    { preHandler: [requireAuth, requireRole('owner')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const batch = await approveBatch({ batchId: id, checkerId: req.auth!.userId, merchantId: req.auth!.merchantId });
        return reply.send(JSON.parse(JSON.stringify(batch, bigintReplacer)));
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );

  // Execute (and retry) — idempotent per item, so calling twice is safe.
  app.post(
    '/batches/:id/execute',
    { preHandler: [requireAuth, requireRole('owner')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const result = await executeBatch({ batchId: id, merchantId: req.auth!.merchantId });
        return reply.send(JSON.parse(JSON.stringify(result, bigintReplacer)));
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );
}
