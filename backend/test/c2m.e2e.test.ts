import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Phase 0 end-to-end: a real customer-to-merchant payment over HTTP, against a
 * real Postgres — the journey the two front-ends now drive.
 *
 * This is the test the audit called for and could not find: it asserts not just
 * "the call returned 201" but that the money landed as exactly one balanced
 * double-entry movement on BOTH ledgers, and that the customer-side and
 * merchant-side clearing legs net to zero against each other.
 *
 * Needs Postgres (docker compose up) with migrations applied. It is skipped
 * rather than failed when no database is reachable, so `npm test` still runs
 * everywhere.
 */

const prismaMod = await import('../src/db/client.js');
const { prisma } = prismaMod;
const { buildApp } = await import('../src/app.js');

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

const d = dbUp ? describe : describe.skip;

const app = buildApp();
const pepper = process.env.ARGON2_PEPPER ?? '';
const hash = (s: string) => argon2.hash(s + pepper, { type: argon2.argon2id });

// Unique per run so repeated runs never collide on a unique key.
const run = randomUUID().slice(0, 8);
const OWNER_EMAIL = `owner-${run}@e2e.test`;
const CASHIER_EMAIL = `cashier-${run}@e2e.test`;
const CUSTOMER_TAG = `@e2e${run.replace(/[^a-z0-9]/g, '')}`;
const PIN = '2468';
const OPENING = 500000n; // KES 500,000 — KES is zero-decimal here (chat.lib currencyDecimals)
const AMOUNT = 125000n; // KES 125,000

let merchantId = '';
let customerId = '';
let ownerToken = '';
let cashierToken = '';
let customerToken = '';
let tillNumber = '';

/** Sum of a ledger side for one merchant transaction. */
async function txnLegs(transactionId: string) {
  const entries = await prisma.ledgerEntry.findMany({ where: { transactionId } });
  const net = entries.reduce((s, e) => s + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n);
  return { entries, net };
}

async function transferLegs(transferId: string) {
  const entries = await prisma.customerLedgerEntry.findMany({ where: { transferId } });
  const net = entries.reduce((s, e) => s + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n);
  return { entries, net };
}

async function walletBalance(id: string) {
  const w = await prisma.customerAccount.findUniqueOrThrow({ where: { customerId: id } });
  return w.balanceMinor;
}

async function merchantBalance(id: string) {
  const a = await prisma.account.findFirstOrThrow({ where: { merchantId: id, type: 'axo_balance', currency: 'KES' } });
  return a.balanceMinor;
}

d('Phase 0 — customer-to-merchant payment, end to end over HTTP', () => {
  beforeAll(async () => {
    await app.ready();

    // 1. A business onboards through the public route the Hub calls.
    const onboard = await app.inject({
      method: 'POST',
      url: '/merchants',
      payload: {
        legalName: `E2E Traders ${run} Ltd`,
        tradingName: `E2E Traders ${run}`,
        country: 'KE',
        currency: 'KES',
        owner: { name: 'E2E Owner', email: OWNER_EMAIL, password: 'password123' },
      },
    });
    expect(onboard.statusCode).toBe(201);
    merchantId = onboard.json().id;

    // A second staff user, to prove the role gate on issuance.
    await prisma.user.create({
      data: { merchantId, name: 'E2E Cashier', email: CASHIER_EMAIL, role: 'cashier', passwordHash: await hash('password123') },
    });

    // 2. A funded customer with a PIN — the individual app's login credential.
    const customer = await prisma.customer.create({
      data: {
        axoTag: CUSTOMER_TAG,
        displayName: 'E2E Payer',
        country: 'KE',
        currency: 'KES',
        status: 'active',
        kycTier: 'verified',
        pinHash: await hash(PIN),
        wallet: { create: { currency: 'KES', balanceMinor: OPENING } },
      },
    });
    customerId = customer.id;

    const ownerLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: OWNER_EMAIL, password: 'password123' } });
    ownerToken = ownerLogin.json().accessToken;
    const cashierLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: CASHIER_EMAIL, password: 'password123' } });
    cashierToken = cashierLogin.json().accessToken;
  });

  afterAll(async () => {
    // Clean up this run's rows, children first.
    const transfers = await prisma.p2PTransfer.findMany({ where: { OR: [{ senderId: customerId }, { recipientId: customerId }] } });
    for (const t of transfers) await prisma.customerLedgerEntry.deleteMany({ where: { transferId: t.id } });
    await prisma.p2PTransfer.deleteMany({ where: { OR: [{ senderId: customerId }, { recipientId: customerId }] } });
    const txns = await prisma.transaction.findMany({ where: { merchantId } });
    for (const t of txns) await prisma.ledgerEntry.deleteMany({ where: { transactionId: t.id } });
    await prisma.transaction.deleteMany({ where: { merchantId } });
    await prisma.payNumberLine.deleteMany({ where: { payNumber: { merchantId } } });
    await prisma.payNumber.deleteMany({ where: { merchantId } });
    await prisma.customerAccount.deleteMany({ where: { customerId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.user.deleteMany({ where: { merchantId } });
    await prisma.account.deleteMany({ where: { merchantId } });
    await prisma.merchant.deleteMany({ where: { id: merchantId } });
    await app.close();
  });

  it('issues a Till to the business — owner only', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/paynumbers',
      headers: { authorization: `Bearer ${cashierToken}` },
      payload: { kind: 'till', label: 'Shop counter' },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: '/paynumbers',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { kind: 'till', label: 'Shop counter' },
    });
    expect(res.statusCode).toBe(201);
    tillNumber = res.json().number;
    expect(tillNumber).toMatch(/^\d{6}$/);
  });

  it('lets the customer log in with their PIN and read a real balance', async () => {
    const login = await app.inject({ method: 'POST', url: '/customer/auth/login', payload: { axoTag: CUSTOMER_TAG, pin: PIN } });
    expect(login.statusCode).toBe(200);
    customerToken = login.json().accessToken;

    const me = await app.inject({ method: 'GET', url: '/customer/me', headers: { authorization: `Bearer ${customerToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().wallet.balanceMinor).toBe(OPENING.toString());
  });

  it('refuses a customer token on a merchant route, and a merchant token on a customer route', async () => {
    const asCustomer = await app.inject({
      method: 'GET',
      url: '/paynumbers',
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(asCustomer.statusCode).toBe(401);
    expect(asCustomer.json().error).toBe('wrong_token_type');

    const asMerchant = await app.inject({
      method: 'GET',
      url: '/customer/me',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(asMerchant.statusCode).toBe(401);
  });

  it('resolves the Till to the business name before any money moves', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/customer/pay-numbers/resolve',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { kind: 'till', number: tillNumber },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantName).toBe(`E2E Traders ${run}`);

    const unknown = await app.inject({
      method: 'POST',
      url: '/customer/pay-numbers/resolve',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { kind: 'till', number: '000001' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('rejects a wrong PIN without moving money', async () => {
    const before = await walletBalance(customerId);
    const res = await app.inject({
      method: 'POST',
      url: '/customer/payments/by-number',
      headers: { authorization: `Bearer ${customerToken}`, 'idempotency-key': `wrongpin-${run}` },
      payload: { kind: 'till', number: tillNumber, amountMinor: AMOUNT.toString(), pin: '9999' },
    });
    expect(res.statusCode).toBe(401);
    expect(await walletBalance(customerId)).toBe(before);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/customer/payments/by-number',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { kind: 'till', number: tillNumber, amountMinor: AMOUNT.toString(), pin: PIN },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('missing_idempotency_key');
  });

  it('pays the Till: money moves once, balanced on both ledgers', async () => {
    const key = `pay-${run}`;
    const customerBefore = await walletBalance(customerId);
    const merchantBefore = await merchantBalance(merchantId);

    const res = await app.inject({
      method: 'POST',
      url: '/customer/payments/by-number',
      headers: { authorization: `Bearer ${customerToken}`, 'idempotency-key': key },
      payload: { kind: 'till', number: tillNumber, amountMinor: AMOUNT.toString(), pin: PIN },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.merchantName).toBe(`E2E Traders ${run}`);
    expect(body.amountMinor).toBe(AMOUNT.toString());

    // Cached balances moved by exactly the amount, in opposite directions.
    expect(await walletBalance(customerId)).toBe(customerBefore - AMOUNT);
    expect(await merchantBalance(merchantId)).toBe(merchantBefore + AMOUNT);
    // The receipt's balance is the real post-posting wallet balance.
    expect(body.balanceMinor).toBe((customerBefore - AMOUNT).toString());

    // Exactly ONE merchant transaction, and its legs net to zero.
    const txns = await prisma.transaction.findMany({ where: { merchantId, type: 'payment_in' } });
    expect(txns).toHaveLength(1);
    expect(txns[0]!.status).toBe('confirmed');
    const m = await txnLegs(txns[0]!.id);
    expect(m.entries).toHaveLength(2);
    expect(m.net).toBe(0n);

    // The customer-side posting also nets to zero.
    const c = await transferLegs(body.transferId);
    expect(c.entries).toHaveLength(2);
    expect(c.net).toBe(0n);

    // Cross-ledger: the customer-side clearing CREDIT and the merchant-side
    // clearing DEBIT are the bridge between the two ledgers. They must cancel,
    // or the platform is holding money it cannot account for.
    const merchantClearing = await prisma.account.findFirstOrThrow({ where: { merchantId, type: 'clearing', currency: 'KES' } });
    const merchantClearingLeg = m.entries.find((e) => e.accountId === merchantClearing.id);
    expect(merchantClearingLeg?.direction).toBe('debit');

    const clearingCustomer = await prisma.customer.findUniqueOrThrow({ where: { axoTag: '@axo_clearing_kes' }, include: { wallet: true } });
    const customerClearingLeg = c.entries.find((e) => e.accountId === clearingCustomer.wallet!.id);
    expect(customerClearingLeg?.direction).toBe('credit');

    const bridgeNet =
      (customerClearingLeg!.direction === 'credit' ? customerClearingLeg!.amountMinor : -customerClearingLeg!.amountMinor) +
      (merchantClearingLeg!.direction === 'credit' ? merchantClearingLeg!.amountMinor : -merchantClearingLeg!.amountMinor);
    expect(bridgeNet).toBe(0n);
  });

  it('replaying the same Idempotency-Key makes no second payment', async () => {
    const key = `pay-${run}`; // the SAME key as the successful payment
    const customerBefore = await walletBalance(customerId);
    const merchantBefore = await merchantBalance(merchantId);

    const res = await app.inject({
      method: 'POST',
      url: '/customer/payments/by-number',
      headers: { authorization: `Bearer ${customerToken}`, 'idempotency-key': key },
      payload: { kind: 'till', number: tillNumber, amountMinor: AMOUNT.toString(), pin: PIN },
    });
    expect(res.statusCode).toBe(201);
    // Same receipt shape on a replay as on the original call.
    expect(res.json().status).toBe('completed');
    expect(res.json().transferId).toBeTruthy();

    // Nothing moved the second time.
    expect(await walletBalance(customerId)).toBe(customerBefore);
    expect(await merchantBalance(merchantId)).toBe(merchantBefore);
    const txns = await prisma.transaction.findMany({ where: { merchantId, type: 'payment_in' } });
    expect(txns).toHaveLength(1);
    const transfers = await prisma.p2PTransfer.findMany({ where: { senderId: customerId } });
    expect(transfers).toHaveLength(1);
  });

  it('shows the credit to the business on its own transactions feed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/transactions?type=payment_in',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].amountMinor).toBe(AMOUNT.toString());
    expect(rows[0].status).toBe('confirmed');
    expect(rows[0].provider).toBe('axo');
  });

  it('declines a payment larger than the wallet, leaving balances untouched', async () => {
    const customerBefore = await walletBalance(customerId);
    const merchantBefore = await merchantBalance(merchantId);
    const res = await app.inject({
      method: 'POST',
      url: '/customer/payments/by-number',
      headers: { authorization: `Bearer ${customerToken}`, 'idempotency-key': `toobig-${run}` },
      payload: { kind: 'till', number: tillNumber, amountMinor: (OPENING * 10n).toString(), pin: PIN },
    });
    expect(res.statusCode).toBe(409);
    expect(await walletBalance(customerId)).toBe(customerBefore);
    expect(await merchantBalance(merchantId)).toBe(merchantBefore);
  });
});
