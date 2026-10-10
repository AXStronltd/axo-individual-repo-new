import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db/client.js';
import { bigintReplacer } from '../lib/money.js';

/**
 * Idempotency for money-moving endpoints. Requires an Idempotency-Key header.
 * A key already seen replays the stored response and skips the handler, so a
 * retried request can never create a second payment.
 *
 * Usage: call `beginIdempotent` at the top of a handler; if it returns a stored
 * response, send it and return. Otherwise run the work and call `finishIdempotent`.
 */
export async function beginIdempotent(
  req: FastifyRequest,
  reply: FastifyReply,
  endpoint: string,
): Promise<{ key: string; replay?: unknown } | null> {
  const key = (req.headers['idempotency-key'] as string | undefined)?.trim();
  if (!key) {
    reply.code(400).send({ error: 'missing_idempotency_key' });
    return null;
  }
  const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
  if (existing) {
    return { key, replay: JSON.parse(existing.responseJson) };
  }
  return { key };
}

export async function finishIdempotent(
  key: string,
  merchantId: string,
  endpoint: string,
  response: unknown,
): Promise<void> {
  await prisma.idempotencyKey.create({
    data: {
      key,
      merchantId,
      endpoint,
      responseJson: JSON.stringify(response, bigintReplacer),
    },
  });
}
