import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bigintReplacer } from '../../lib/money.js';
import { quoteFx } from './fx.lib.js';
import { startCashOut } from '../cash/cash.service.js';

// Demo rate table (a real build pulls live rates). Units of TO per 1 FROM.
const RATES: Record<string, number> = {
  'USD:KES': 129, 'KES:USD': 1 / 129,
  'USD:USDC': 1, 'USDC:USD': 1,
  'USD:EUR': 0.92, 'EUR:USD': 1 / 0.92,
  'USD:SOS': 571, 'USD:USDT': 1,
};

function toBig(v: string | number): bigint | null { try { return BigInt(v); } catch { return null; } }

export async function globalRoutes(app: FastifyInstance) {
  // Quote a cross-border transfer (no money moves). Spread is disclosed.
  app.post('/global/quote', { preHandler: [requireAuth] }, async (req, reply) => {
    const body = z.object({
      sendMinor: z.union([z.string(), z.number()]),
      fromCurrency: z.string().length(3),
      toCurrency: z.string().min(3).max(4),
      spreadBps: z.number().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const rate = RATES[`${body.data.fromCurrency}:${body.data.toCurrency}`];
    if (!rate) return reply.code(422).send({ error: 'no_rate', pair: `${body.data.fromCurrency}:${body.data.toCurrency}` });
    const amt = toBig(body.data.sendMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });
    try {
      const q = quoteFx({ sendMinor: amt, fromCurrency: body.data.fromCurrency, toCurrency: body.data.toCurrency, rate, spreadBps: body.data.spreadBps });
      return reply.send(JSON.parse(JSON.stringify(q, bigintReplacer)));
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  // Send globally: quote, then execute as a cash-out through a configured ramp
  // (e.g. the crypto rail for a stablecoin payout, or a bank/agent ramp abroad).
  // Reserves funds and settles on the ramp webhook, like any cash-out.
  app.post('/global/send', { preHandler: [requireAuth, requireRole('owner', 'accountant')] }, async (req, reply) => {
    const body = z.object({
      customerId: z.string(),
      sendMinor: z.union([z.string(), z.number()]),
      fromCurrency: z.string().length(3),
      toCurrency: z.string().min(3).max(4),
      destination: z.string().min(1), // wallet address / foreign account / phone
      provider: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) return reply.code(400).send({ error: 'missing_idempotency_key' });
    const rate = RATES[`${body.data.fromCurrency}:${body.data.toCurrency}`];
    if (!rate) return reply.code(422).send({ error: 'no_rate' });
    const amt = toBig(body.data.sendMinor);
    if (amt === null) return reply.code(400).send({ error: 'bad_amount' });

    const quote = quoteFx({ sendMinor: amt, fromCurrency: body.data.fromCurrency, toCurrency: body.data.toCurrency, rate });
    try {
      // Debit the sender in their own currency; the ramp delivers the dest amount.
      const r = await startCashOut({
        customerId: body.data.customerId,
        amountMinor: amt,
        currency: body.data.fromCurrency,
        destination: `${body.data.toCurrency}:${body.data.destination}`,
        idempotencyKey: key,
        providerName: body.data.provider,
      });
      if (r.status === 'unavailable') return reply.code(503).send({ error: 'ramp_unavailable', reason: r.reason, quote: JSON.parse(JSON.stringify(quote, bigintReplacer)) });
      return reply.code(201).send(JSON.parse(JSON.stringify({ ...r, quote }, bigintReplacer)));
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
}
