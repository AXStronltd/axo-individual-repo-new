import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';

/**
 * The wallet's own HTTP surface: send to an @tag (PIN step-up, idempotent) and
 * the "pay me" QR. Every failure case asserts that no money moved.
 * Skipped (not failed) when no database is reachable.
 */

const { prisma } = await import('../src/db/client.js');
const { buildApp } = await import('../src/app.js');
const { sendP2P } = await import('../src/modules/p2p/p2p.service.js');

let dbUp = false;
try { await prisma.$queryRaw`SELECT 1`; dbUp = true; } catch { dbUp = false; }
const d = dbUp ? describe : describe.skip;

const app = buildApp();
const pepper = process.env.ARGON2_PEPPER ?? '';
const hash = (s: string) => argon2.hash(s + pepper, { type: argon2.argon2id });
const run = randomUUID().replace(/-/g, '').slice(0, 10);
const PIN = '2468';

const ids = { a: '', b: '', aTag: '', bTag: '', aToken: '', clearingId: '' };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const wallet = async (id: string) => (await prisma.customerAccount.findUniqueOrThrow({ where: { customerId: id } })).balanceMinor;
const send = (payload: Record<string, unknown>, key?: string, token = ids.aToken) =>
  app.inject({ method: 'POST', url: '/customer/transfers', headers: { ...auth(token), ...(key ? { 'idempotency-key': key } : {}) }, payload });

d('Wallet API — send to @tag and receive QR', () => {
  beforeAll(async () => {
    await app.ready();
    for (const who of ['a', 'b'] as const) {
      const c = await prisma.customer.create({
        data: {
          axoTag: `@w${who}${run}`, displayName: `Wallet ${who}`, country: 'KE', currency: 'KES', status: 'active', kycTier: 'verified',
          pinHash: await hash(PIN), wallet: { create: { currency: 'KES', balanceMinor: who === 'a' ? 10_000n : 0n } },
        },
      });
      ids[who] = c.id;
      ids[`${who}Tag` as 'aTag' | 'bTag'] = c.axoTag;
    }
    ids.aToken = (await app.inject({ method: 'POST', url: '/customer/auth/login', payload: { axoTag: ids.aTag, pin: PIN } })).json().accessToken;
    // Make sure a KES clearing wallet exists to aim at. Other test files run in
    // parallel and may be creating it for their first payment at this moment
    // (on a fresh CI database), so a unique-key clash means "it exists now".
    let clearing = await prisma.customer.findUnique({ where: { axoTag: '@axo_clearing_kes' } });
    if (!clearing) {
      try {
        clearing = await prisma.customer.create({
          data: { axoTag: '@axo_clearing_kes', displayName: 'Axo Clearing (KES)', country: 'XX', currency: 'KES', status: 'active', kycTier: 'verified', wallet: { create: { currency: 'KES' } } },
        });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
        clearing = await prisma.customer.findUniqueOrThrow({ where: { axoTag: '@axo_clearing_kes' } });
      }
    }
    ids.clearingId = clearing.id;
  });

  afterAll(async () => {
    const people = [ids.a, ids.b].filter(Boolean);
    const xfers = await prisma.p2PTransfer.findMany({ where: { OR: [{ senderId: { in: people } }, { recipientId: { in: people } }] } });
    for (const t of xfers) await prisma.customerLedgerEntry.deleteMany({ where: { transferId: t.id } });
    await prisma.p2PTransfer.deleteMany({ where: { id: { in: xfers.map((t) => t.id) } } });
    await prisma.riskCase.deleteMany({ where: { subjectId: { in: [...people, ...xfers.map((t) => t.id)] } } });
    await prisma.customerAccount.deleteMany({ where: { customerId: { in: people } } });
    await prisma.customer.deleteMany({ where: { id: { in: people } } });
    await app.close();
  });

  it('sends to an @tag with the PIN; balances move once and the receipt shows the new balance', async () => {
    const res = await send({ toTag: ids.bTag, amountMinor: '500', note: 'lunch', pin: PIN }, `s1-${run}`);
    expect(res.statusCode).toBe(201);
    expect(res.json().to).toBe(ids.bTag);
    expect(BigInt(res.json().balanceMinor)).toBe(9_500n);
    expect(await wallet(ids.a)).toBe(9_500n);
    expect(await wallet(ids.b)).toBe(500n);
  });

  it('a retry with the same Idempotency-Key returns the same transfer and sends nothing more', async () => {
    const res = await send({ toTag: ids.bTag, amountMinor: '500', note: 'lunch', pin: PIN }, `s1-${run}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().replayed).toBe(true);
    expect(await wallet(ids.a)).toBe(9_500n);
    expect(await wallet(ids.b)).toBe(500n);
  });

  it('refuses without the right PIN, without a key, or with a merchant-style token — nothing moves', async () => {
    expect((await send({ toTag: ids.bTag, amountMinor: '100', pin: '0000' }, `s2-${run}`)).statusCode).toBe(401);
    expect((await send({ toTag: ids.bTag, amountMinor: '100', pin: PIN })).statusCode).toBe(400);
    expect((await send({ toTag: ids.bTag, amountMinor: '100', pin: PIN }, `s3-${run}`, 'not-a-token')).statusCode).toBe(401);
    expect(await wallet(ids.a)).toBe(9_500n);
  });

  it('refuses unknown tags, yourself, and more than you have — nothing moves', async () => {
    expect((await send({ toTag: '@nobody' + run, amountMinor: '100', pin: PIN }, `s4-${run}`)).statusCode).toBe(404);
    expect((await send({ toTag: ids.aTag, amountMinor: '100', pin: PIN }, `s5-${run}`)).statusCode).toBe(409);
    const tooMuch = await send({ toTag: ids.bTag, amountMinor: '999999', pin: PIN }, `s6-${run}`);
    expect(tooMuch.statusCode).toBe(409);
    expect(await wallet(ids.a)).toBe(9_500n);
  });

  it('can never send into the internal clearing wallet — over HTTP or through the service', async () => {
    expect((await send({ toTag: '@axo_clearing_kes', amountMinor: '100', pin: PIN }, `s7-${run}`)).statusCode).toBe(404);
    await expect(sendP2P({ senderId: ids.a, recipientId: ids.clearingId, amountMinor: 100n, currency: 'KES' })).rejects.toThrow();
    // The clearing wallet's own balance moves with every other test's payments
    // (they run in parallel), so check what matters: nothing went from A to it.
    expect(await prisma.p2PTransfer.count({ where: { senderId: ids.a, recipientId: ids.clearingId } })).toBe(0);
    expect(await wallet(ids.a)).toBe(9_500n);
  });

  it('serves my "pay me" QR as SVG, and it resolves back to my tag when scanned', async () => {
    const res = await app.inject({ method: 'GET', url: '/customer/receive-qr.svg', headers: auth(ids.aToken) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.body).toContain('<svg');
    const scan = await app.inject({ method: 'POST', url: '/customer/scan', headers: auth(ids.aToken), payload: { qr: `axo://pay?k=tag&t=${encodeURIComponent(ids.bTag)}` } });
    expect(scan.json()).toEqual({ kind: 'tag', tag: ids.bTag });
  });
});
