import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { createHash, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db/client.js';

// The JWT payload we sign at merchant login.
export interface AuthClaims {
  userId: string;
  merchantId: string;
  role: Role;
}

// The JWT payload we sign at CUSTOMER login (the individual wallet app). It
// carries no merchant and no role: a customer is not a member of a business.
export interface CustomerClaims {
  customerId: string;
  typ: 'customer';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthClaims;
    customer?: CustomerClaims;
  }
}

/**
 * Verify the bearer token as a MERCHANT access token and attach claims.
 *
 * Tokens carrying a `typ` marker are refused outright: a refresh token
 * (typ='refresh') and a customer token (typ='customer') are both signed with
 * the same secret, so without this check either would sail through here and be
 * treated as a staff session.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  // A POS / back office authenticates with an API key instead of a staff login.
  // It acts as its merchant with the key's fixed role, so requireRole still
  // applies to it exactly as to a person.
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string') {
    const claims = await claimsForApiKey(apiKey);
    if (!claims) return reply.code(401).send({ error: 'unauthorized' });
    req.auth = claims;
    return;
  }
  try {
    const claims = await req.jwtVerify<AuthClaims & { typ?: string }>();
    if (claims.typ) return reply.code(401).send({ error: 'wrong_token_type' });
    if (!claims.merchantId || !claims.userId) return reply.code(401).send({ error: 'unauthorized' });
    req.auth = claims;
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

/**
 * Verify the bearer token as a CUSTOMER access token and attach the customerId.
 *
 * This is what makes a customer-facing money route safe: the wallet being spent
 * is the one named in the token, so a caller can never move someone else's
 * money by naming them in the body.
 */
export async function requireCustomer(req: FastifyRequest, reply: FastifyReply) {
  try {
    const claims = await req.jwtVerify<CustomerClaims>();
    if (claims.typ !== 'customer' || !claims.customerId) {
      return reply.code(401).send({ error: 'wrong_token_type' });
    }
    req.customer = { customerId: claims.customerId, typ: 'customer' };
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

/**
 * Server-side role gate. The front-end hides tiles by role for UX; this is the
 * real enforcement — a cashier's token cannot call an owner-only route even if
 * the request is hand-crafted.
 */
export function requireRole(...allowed: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!allowed.includes(req.auth.role)) {
      return reply.code(403).send({ error: 'forbidden', role: req.auth.role });
    }
  };
}

/** API-key callers carry this userId prefix, so routes can tell a machine from a person. */
export const API_KEY_ACTOR_PREFIX = 'apikey:';

export function isApiKeyCaller(req: FastifyRequest): boolean {
  return !!req.auth?.userId.startsWith(API_KEY_ACTOR_PREFIX);
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Keys look like axo_sk_<prefix>_<secret>; the prefix finds the row, the hash proves it. */
export function apiKeyPrefix(key: string): string | null {
  const m = /^axo_sk_([A-Za-z0-9]{8,16})_[A-Za-z0-9_-]{24,}$/.exec(key);
  return m ? m[1]! : null;
}

async function claimsForApiKey(key: string): Promise<AuthClaims | null> {
  const prefix = apiKeyPrefix(key);
  if (!prefix) return null;
  const row = await prisma.apiKey.findUnique({ where: { prefix } });
  if (!row || row.revokedAt) return null;
  const a = Buffer.from(hashApiKey(key));
  const b = Buffer.from(row.keyHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // last-used is informational; don't let it slow or fail the request
  prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { userId: API_KEY_ACTOR_PREFIX + row.id, merchantId: row.merchantId, role: row.role };
}
