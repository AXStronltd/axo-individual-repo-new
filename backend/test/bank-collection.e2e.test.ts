import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Bank collection end to end over HTTP: a customer asks to top up by bank
 * transfer, and the wallet is credited only by the collection bank's signed
 * webhook or by a platform operator — exactly once, with both ledger legs.
 * Skipped (not failed) when no database is reachable.
 */

const OPS_KEY = 'ops-' + 'k'.repeat(40);
const BANK_SECRET = 'bank-' + 's'.repeat(40);
process.env.OPS_API_KEY = OPS_KEY;
process.env.BANK_WEBHOOK_SECRET = BANK_SECRET;
process.env.BANK_COLLECTION_ACCOUNTS = JSON.stringify({
  testbank: { bankName: 'Test Bank', accountName: 'Axo Test', accountNumber: '000111', network: 'Test RTGS' },
  usdonly: { bankName: 'Dollar Bank', accountName: 'Axo Test', accountNumber: '000222', currencies: ['USD'] },
});

const { prisma } = await import('../src/db/client.js');
const { buildApp } = await import('../src/app.js');
const { signBankWebhook } = await import('../src/modules/cash/bank.lib.js');
const { sweepExpiredBankIntents } = await import('../src/modules/cash/bank.service.js');

let dbUp = false;
try { await prisma.$queryRaw`SELECT 1`; dbUp = true; } catch { dbUp = false; }
const d = dbUp ? describe : describe.skip;

const app = buildApp();
const pepper = process.env.ARGON2_PEPPER ?? '';
const run = randomUUID().replace(/-/g, '').slice(0, 10);
const PIN = '1357';
const people: string[] = [];
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const wallet = async (id: string) => (await prisma.customerAccount.findUniqueOrThrow({ where: { customerId: id } })).balanceMinor;

async function makeCustomer(name: string) {
  const c = await prisma.customer.create({
    data: {
      axoTag: `@bk${name}${run}`, displayName: `Bank ${name}`, country: 'KE', currency: 'KES', status: 'active', kycTier: 'verified',
      pinHash: await argon2.hash(PIN + pepper, { type: argon2.argon2id }), wallet: { create: { currency: 'KES' } },
    },
  });
  people.push(c.id);
  const token = (await app.inject({ method: 'POST', url: '/customer/auth/login', payload: { axoTag: c.axoTag, pin: PIN } })).json().accessToken as string;
  return { id: c.id, token };
}

const intent = (token: string, payload: Record<string, unknown>, key?: string) =>
  app.inject({ method: 'POST', url: '/customer/bank-deposits', headers: { ...auth(token), ...(key ? { 'idempotency-key': key } : {}) }, payload });

function webhook(bank: string, body: Record<string, unknown>, secret = BANK_SECRET) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST', url: `/collections/bank/webhook/${bank}`,
    headers: { 'content-type': 'application/json', 'x-axo-signature': signBankWebhook(raw, secret) }, payload: raw,
  });
}

const manual = (reference: string, payload: Record<string, unknown>, headers: Record<string, string> = { 'x-ops-key': OPS_KEY }) =>
  app.inject({ method: 'POST', url: `/collections/bank/${reference}/confirm-manual`, headers, payload });

/** Every movement for these customers nets to zero across its ledger legs. */
async function ledgerBalanced(customerId: string) {
  const cts = await prisma.cashTransfer.findMany({ where: { customerId, provider: 'bank' } });
  for (const ct of cts) {
    const legs = await prisma.customerLedgerEntry.findMany({ where: { transferId: ct.id } });
    expect(legs).toHaveLength(2);
    expect(legs.reduce((n, e) => n + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n)).toBe(0n);
  }
  return cts.length;
}

d('Bank collection — top up a wallet by bank transfer', () => {
  let amina: { id: string; token: string };
  let juma: { id: string; token: string };

  beforeAll(async () => {
    await app.ready();
    amina = await makeCustomer('amina');
    juma = await makeCustomer('juma');
  });

  afterAll(async () => {
    const cts = await prisma.cashTransfer.findMany({ where: { customerId: { in: people } } });
    await prisma.customerLedgerEntry.deleteMany({ where: { transferId: { in: cts.map((c) => c.id) } } });
    await prisma.bankDepositIntent.deleteMany({ where: { customerId: { in: people } } });
    await prisma.cashTransfer.deleteMany({ where: { id: { in: cts.map((c) => c.id) } } });
    await prisma.customerAccount.deleteMany({ where: { customerId: { in: people } } });
    await prisma.customer.deleteMany({ where: { id: { in: people } } });
    await app.close();
  });

  it('lists only the collection accounts that take my currency', async () => {
    const res = await app.inject({ method: 'GET', url: '/customer/bank-deposits/accounts', headers: auth(amina.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe('KES');
    expect(res.json().accounts.map((a: any) => a.bank)).toEqual(['testbank']);
  });

  it('issues a reference and account details, moves no money, and replays on the same key', async () => {
    const res = await intent(amina.token, { amountMinor: '5000', bank: 'testbank' }, `i1-${run}`);
    expect(res.statusCode).toBe(201);
    expect(res.json().reference).toMatch(/^AXO-TEST-\d{6}$/);
    expect(res.json()).toMatchObject({ status: 'awaiting', currency: 'KES', amountMinor: '5000', account: { accountNumber: '000111' } });
    expect(res.json().idempotencyKey).toBeUndefined();
    expect(await wallet(amina.id)).toBe(0n);
    const again = await intent(amina.token, { amountMinor: '5000', bank: 'testbank' }, `i1-${run}`);
    expect(again.statusCode).toBe(200);
    expect(again.json().reference).toBe(res.json().reference);
  });

  it('refuses a missing key, a bad amount, an unknown bank, a bank that does not take my currency, or no customer token', async () => {
    expect((await intent(amina.token, { amountMinor: '5000', bank: 'testbank' })).statusCode).toBe(400);
    expect((await intent(amina.token, { amountMinor: '0', bank: 'testbank' }, `i2-${run}`)).statusCode).toBe(400);
    expect((await intent(amina.token, { amountMinor: '5000', bank: 'nobank' }, `i3-${run}`)).statusCode).toBe(404);
    const usd = await intent(amina.token, { amountMinor: '5000', bank: 'usdonly' }, `i4-${run}`);
    expect(usd.statusCode).toBe(409);
    expect(usd.json().error).toBe('currency_not_accepted');
    expect((await intent('not-a-token', { amountMinor: '5000', bank: 'testbank' }, `i5-${run}`)).statusCode).toBe(401);
  });

  it('the signed bank webhook credits the wallet once, with both ledger legs', async () => {
    const ref = (await intent(amina.token, { amountMinor: '2000', bank: 'testbank' }, `w1-${run}`)).json().reference;
    const before = await wallet(amina.id);
    const res = await webhook('testbank', { reference: ref, amountMinor: '2000', currency: 'KES', bankRef: `TB-${run}-1` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: true, status: 'credited' });
    expect(await wallet(amina.id)).toBe(before + 2000n);

    // The bank retries the same notification: acknowledged, nothing more credited.
    const replay = await webhook('testbank', { reference: ref, amountMinor: '2000', currency: 'KES', bankRef: `TB-${run}-1` });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().applied).toBe(false);
    expect(await wallet(amina.id)).toBe(before + 2000n);

    const list = await app.inject({ method: 'GET', url: '/customer/bank-deposits', headers: auth(amina.token) });
    expect(list.json().deposits.find((x: any) => x.reference === ref).status).toBe('credited');
    expect(await ledgerBalanced(amina.id)).toBeGreaterThan(0);
  });

  it('one bank transaction can never credit two references', async () => {
    const ref = (await intent(amina.token, { amountMinor: '700', bank: 'testbank' }, `w2-${run}`)).json().reference;
    const before = await wallet(amina.id);
    const res = await webhook('testbank', { reference: ref, amountMinor: '700', currency: 'KES', bankRef: `TB-${run}-1` });
    expect(res.json()).toMatchObject({ applied: false, reason: 'bank_ref_already_used' });
    expect(await wallet(amina.id)).toBe(before);
  });

  it('credits what the bank actually received, and matches a reference however it was typed', async () => {
    const ref: string = (await intent(amina.token, { amountMinor: '5000', bank: 'testbank' }, `w3-${run}`)).json().reference;
    const before = await wallet(amina.id);
    const res = await webhook('testbank', { reference: ref.toLowerCase().replace(/-/g, ' '), amountMinor: '4800', currency: 'KES', bankRef: `TB-${run}-3` });
    expect(res.json().applied).toBe(true);
    expect(await wallet(amina.id)).toBe(before + 4800n);
  });

  it('refuses a forged or unsigned webhook, the wrong bank, the wrong currency, or no bank transaction id — nothing moves', async () => {
    const ref = (await intent(amina.token, { amountMinor: '900', bank: 'testbank' }, `w4-${run}`)).json().reference;
    const before = await wallet(amina.id);
    const body = { reference: ref, amountMinor: '900', currency: 'KES', bankRef: `TB-${run}-4` };
    expect((await webhook('testbank', body, 'wrong-secret-' + 'x'.repeat(30))).statusCode).toBe(401);
    const unsigned = await app.inject({ method: 'POST', url: '/collections/bank/webhook/testbank', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect(unsigned.statusCode).toBe(401);
    expect((await webhook('usdonly', body)).json().reason).toBe('bank_mismatch');
    expect((await webhook('testbank', { ...body, currency: 'USD' })).json().reason).toBe('currency_mismatch');
    expect((await webhook('testbank', { reference: ref, amountMinor: '900', currency: 'KES' })).statusCode).toBe(400);
    expect((await webhook('testbank', { ...body, amountMinor: '-900' })).statusCode).toBe(400);
    expect(await wallet(amina.id)).toBe(before);
  });

  it('manual confirmation is for platform operators only — not customers, not merchant tokens', async () => {
    const ref = (await intent(juma.token, { amountMinor: '1500', bank: 'testbank' }, `m1-${run}`)).json().reference;
    const body = { amountMinor: '1500', currency: 'KES', bankRef: `STMT-${run}-1` };
    expect((await manual(ref, body, {})).statusCode).toBe(401);
    expect((await manual(ref, body, auth(juma.token))).statusCode).toBe(401);
    expect((await manual(ref, body, { 'x-ops-key': 'guess' })).statusCode).toBe(401);
    expect(await wallet(juma.id)).toBe(0n);

    const ok = await manual(ref, body);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ applied: true });
    expect(await wallet(juma.id)).toBe(1500n);
    expect((await manual(ref, body)).json().reason).toBe('already_credited');
    expect(await wallet(juma.id)).toBe(1500n);
    expect(await ledgerBalanced(juma.id)).toBe(1);
  });

  it('a customer can cancel only their own reference, and a cancelled one is never credited', async () => {
    const ref = (await intent(amina.token, { amountMinor: '300', bank: 'testbank' }, `c1-${run}`)).json().reference;
    const theirs = await app.inject({ method: 'POST', url: `/customer/bank-deposits/${ref}/cancel`, headers: auth(juma.token) });
    expect(theirs.statusCode).toBe(404);
    const mine = await app.inject({ method: 'POST', url: `/customer/bank-deposits/${ref}/cancel`, headers: auth(amina.token) });
    expect(mine.statusCode).toBe(200);
    const before = await wallet(amina.id);
    expect((await webhook('testbank', { reference: ref, amountMinor: '300', currency: 'KES', bankRef: `TB-${run}-c1` })).json().reason).toBe('intent_cancelled');
    expect(await wallet(amina.id)).toBe(before);
  });

  it('a lapsed reference is swept to expired, but money that still arrives is credited', async () => {
    const ref = (await intent(amina.token, { amountMinor: '400', bank: 'testbank' }, `e1-${run}`)).json().reference;
    await prisma.bankDepositIntent.update({ where: { reference: ref }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await sweepExpiredBankIntents();
    expect((await prisma.bankDepositIntent.findUniqueOrThrow({ where: { reference: ref } })).status).toBe('expired');
    const before = await wallet(amina.id);
    expect((await webhook('testbank', { reference: ref, amountMinor: '400', currency: 'KES', bankRef: `TB-${run}-e1` })).json().applied).toBe(true);
    expect(await wallet(amina.id)).toBe(before + 400n);
  });

  it('a frozen account is not credited', async () => {
    const ref = (await intent(juma.token, { amountMinor: '600', bank: 'testbank' }, `f1-${run}`)).json().reference;
    await prisma.customer.update({ where: { id: juma.id }, data: { status: 'frozen' } });
    const before = await wallet(juma.id);
    expect((await webhook('testbank', { reference: ref, amountMinor: '600', currency: 'KES', bankRef: `TB-${run}-f1` })).json().reason).toBe('account_frozen');
    expect(await wallet(juma.id)).toBe(before);
    await prisma.customer.update({ where: { id: juma.id }, data: { status: 'active' } });
  });
});
