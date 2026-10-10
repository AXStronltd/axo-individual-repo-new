import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';

// The JWT payload we sign at login.
export interface AuthClaims {
  userId: string;
  merchantId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthClaims;
  }
}

/** Verify the bearer token and attach claims. 401 if missing/invalid. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    const claims = await req.jwtVerify<AuthClaims>();
    req.auth = claims;
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
