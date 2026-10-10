import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { verifySecret } from './hash.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

type Claims = { userId: string; merchantId: string; role: 'owner' | 'manager' | 'cashier' | 'accountant' };

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    // Identical response whether the user is missing or the password is wrong.
    if (!user || !(await verifySecret(user.passwordHash, parsed.data.password))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const claims: Claims = { userId: user.id, merchantId: user.merchantId, role: user.role };
    const accessToken = await reply.jwtSign(claims, { expiresIn: '15m' });
    // Refresh token carries a marker so it can't be used as an access token.
    const refreshToken = await reply.jwtSign({ ...claims, typ: 'refresh' }, { expiresIn: '30d' });

    return { accessToken, refreshToken, role: user.role };
  });

  app.post('/auth/refresh', async (req, reply) => {
    const body = z.object({ refreshToken: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      const decoded = app.jwt.verify<Claims & { typ?: string }>(body.data.refreshToken);
      if (decoded.typ !== 'refresh') return reply.code(401).send({ error: 'not_a_refresh_token' });
      const accessToken = await reply.jwtSign(
        { userId: decoded.userId, merchantId: decoded.merchantId, role: decoded.role },
        { expiresIn: '15m' },
      );
      return { accessToken };
    } catch {
      return reply.code(401).send({ error: 'invalid_refresh' });
    }
  });
}
