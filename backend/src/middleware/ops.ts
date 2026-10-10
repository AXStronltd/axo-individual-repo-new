import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';

/**
 * Gate for PLATFORM-OPERATOR actions — things no merchant, staff member or
 * customer may do on their own: creating agents, funding agent float, settling a
 * claim by verified identity, re-pointing money to a recovered number.
 *
 * These used to sit behind requireAuth, which accepts any merchant's staff
 * token; that let any business mint agent float or redirect another person's
 * money. A separate credential (X-Ops-Key, compared in constant time) keeps them
 * out of reach of the merchant surface. When OPS_API_KEY is unset the routes
 * refuse outright rather than fall back to a weaker check.
 */
export async function requireOps(req: FastifyRequest, reply: FastifyReply) {
  const expected = env.OPS_API_KEY;
  if (!expected) return reply.code(503).send({ error: 'ops_access_not_configured' });
  const given = req.headers['x-ops-key'];
  if (typeof given !== 'string' || !safeEqual(given, expected)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
