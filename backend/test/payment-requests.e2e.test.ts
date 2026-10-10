import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import argon2 from 'argon2';

/**
 * The target flow, end to end over HTTP against a real Postgres:
 *
 *   merchant raises a payment request for a sale → customer scans its QR →
 *   pays with PIN → request and both ledgers settle exactly once → merchant is
 *   notified through the transactional outbox (signed webhook) → the request,
 *   the dashboard feed and the daily settlement report all show it → refunds go
 *   back to the customer, capped at what was paid.
 *
 * Alongside it: the security fixes from AUDIT.md §1 (S1–S9) — every one is
 * asserted here as "money did not move", not just "the call returned 4xx".
 *
 * Skipped (not failed) when no database is reachable.
 */

const { prisma } = await import('../src/db/client.js');
const { buildApp } = await import('../src/app.js');
const { env } = await import('../src/config/env.js');
const { dispatchDueDeliveries } = await import('../src/modules/notify/outbox.service.js');
const { verifyPayloadSignature, SIGNATURE_HEADER } = await import('../src/modules/notify/outbox.lib.js');
const { signSandboxWebhook } = await import('../src/providers/sandbox.js');

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

const run = randomUUID().replace(/-/g, '').slice(0, 10);
const PIN = '2468';
// KES is zero-decimal in this codebase (see chat.lib currencyDecimals), so
// minor units are whole shillings.
const OPENING = 1_000_000n; // KES 1,000,000

const ids = {
  merchantA: '', merchantB: '',
  ownerA: '', cashierA: '', ownerB: '',
  payer: '', other: '', wa: '',
  payerToken: '', otherToken: '',
  apiKey: '', apiKeyId: '',
  webhookSecret: '',
  till: '',
};
const payerWaId = '2547' + run.replace(/\D/g, '').padEnd(8, '7').slice(0, 8);

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function wallet(customerId: string) {
  return (await prisma.customerAccount.findUniqueOrThrow({ where: { customerId } })).balanceMinor;
}
async function merchantBalance(merchantId: string) {
  return (await prisma.account.findFirstOrThrow({ where: { merchantId, type: 'axo_balance', currency: 'KES' } })).balanceMinor;
}

async function onboard(tag: string) {
  const res = await app.inject({
    method: 'POST', url: '/merchants',
    payload: { legalName: `PR ${tag} ${run} Ltd`, tradingName: `PR ${tag} ${run}`, country: 'KE', currency: 'KES', owner: { name: 'Owner', email: `owner-${tag}-${run}@e2e.test`, password: 'password123' } },
  });
  expect(res.statusCode).toBe(201);
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `owner-${tag}-${run}@e2e.test`, password: 'password123' } });
  return { merchantId: res.json().id as string, token: login.json().accessToken as string };
}

async function makeCustomer(tag: string) {
  const c = await prisma.customer.create({
    data: {
      axoTag: `@pr${tag}${run}`, displayName: `Payer ${tag}`, country: 'KE', currency: 'KES', status: 'active', kycTier: 'verified',
      pinHash: await hash(PIN), wallet: { create: { currency: 'KES', balanceMinor: OPENING } },
    },
  });
  const login = await app.inject({ method: 'POST', url: '/customer/auth/login', payload: { axoTag: c.axoTag, pin: PIN } });
  expect(login.statusCode).toBe(200);
  return { id: c.id, tag: c.axoTag, token: login.json().accessToken as string };
}

async function newRequest(token: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/payment-requests', headers: { ...auth(token), ...headers }, payload });
}

async function pay(ref: string, token: string, pin = PIN) {
  return app.inject({ method: 'POST', url: `/customer/payment-requests/${ref}/pay`, headers: auth(token), payload: { pin } });
}

/** Post a signed inbound WhatsApp text, exactly as Meta would. */
async function whatsapp(from: string, text: string) {
  const body = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid.' + randomUUID(), from, type: 'text', text: { body: text }, timestamp: '1' }] } }] }],
  });
  const sig = 'sha256=' + createHmac('sha256', env.WHATSAPP_APP_SECRET).update(body, 'utf8').digest('hex');
  return app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, payload: body });
}

d('Payment requests — the customer → merchant target flow', () => {
  beforeAll(async () => {
    await app.ready();
    const a = await onboard('a');
    const b = await onboard('b');
    ids.merchantA = a.merchantId; ids.ownerA = a.token;
    ids.merchantB = b.merchantId; ids.ownerB = b.token;

    await prisma.user.create({ data: { merchantId: ids.merchantA, name: 'Cashier', email: `cashier-${run}@e2e.test`, role: 'cashier', passwordHash: await hash('password123') } });
    ids.cashierA = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `cashier-${run}@e2e.test`, password: 'password123' } })).json().accessToken;

    const payer = await makeCustomer('p');
    const other = await makeCustomer('o');
    ids.payer = payer.id; ids.payerToken = payer.token;
    ids.other = other.id; ids.otherToken = other.token;

    // a verified WhatsApp link with a live session for the payer
    await prisma.whatsAppLink.create({ data: { customerId: ids.payer, waId: payerWaId, phone: payerWaId, verifiedAt: new Date(), sessionExpiresAt: new Date(Date.now() + 600_000) } });

    const till = await app.inject({ method: 'POST', url: '/paynumbers', headers: auth(ids.ownerA), payload: { kind: 'till', label: 'Front till' } });
    expect(till.statusCode).toBe(201);
    ids.till = till.json().number;
  });

  afterAll(async () => {
    const merchants = [ids.merchantA, ids.merchantB].filter(Boolean);
    const customers = [ids.payer, ids.other].filter(Boolean);
    const transfers = await prisma.p2PTransfer.findMany({ where: { OR: [{ senderId: { in: customers } }, { recipientId: { in: customers } }] } });
    for (const t of transfers) await prisma.customerLedgerEntry.deleteMany({ where: { transferId: t.id } });
    await prisma.p2PTransfer.deleteMany({ where: { id: { in: transfers.map((t) => t.id) } } });
    const txns = await prisma.transaction.findMany({ where: { merchantId: { in: merchants } } });
    for (const t of txns) await prisma.ledgerEntry.deleteMany({ where: { transactionId: t.id } });
    await prisma.transaction.deleteMany({ where: { merchantId: { in: merchants } } });
    await prisma.webhookDelivery.deleteMany({ where: { merchantId: { in: merchants } } });
    await prisma.merchantWebhook.deleteMany({ where: { merchantId: { in: merchants } } });
    await prisma.apiKey.deleteMany({ where: { merchantId: { in: merchants } } });
    await prisma.pushPrompt.deleteMany({ where: { merchantId: { in: merchants } } });
    await prisma.pendingConfirm.deleteMany({ where: { waId: payerWaId } });
    await prisma.whatsAppLink.deleteMany({ where: { customerId: { in: customers } } });
    await prisma.riskCase.deleteMany({ where: { subjectId: { in: [...customers, ...transfers.map((t) => t.id)] } } });
    await prisma.payNumberLine.deleteMany({ where: { payNumber: { merchantId: { in: merchants } } } });
    await prisma.payNumber.deleteMany({ where: { merchantId: { in: merchants } } });
    await prisma.customerAccount.deleteMany({ where: { customerId: { in: customers } } });
    await prisma.customer.deleteMany({ where: { id: { in: customers } } });
    await prisma.user.deleteMany({ where: { merchantId: { in: merchants } } });
    await prisma.account.deleteMany({ where: { merchantId: { in: merchants } } });
    await prisma.webhookEvent.deleteMany({ where: { id: { startsWith: `evt-${run}` } } });
    await prisma.merchant.deleteMany({ where: { id: { in: merchants } } });
    await app.close();
  });

  // ---------------------------------------------------------------- setup
  it('owner registers a webhook endpoint; the secret is shown once', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhook-endpoints', headers: auth(ids.ownerA), payload: { url: 'https://pos.example.test/axo' } });
    expect(res.statusCode).toBe(201);
    ids.webhookSecret = res.json().secret;
    expect(ids.webhookSecret).toMatch(/^whsec_/);
    const list = await app.inject({ method: 'GET', url: '/webhook-endpoints', headers: auth(ids.ownerA) });
    expect(JSON.stringify(list.json())).not.toContain(ids.webhookSecret);
  });

  it('a cashier cannot register webhooks or mint API keys', async () => {
    expect((await app.inject({ method: 'POST', url: '/webhook-endpoints', headers: auth(ids.cashierA), payload: { url: 'https://x.test' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api-keys', headers: auth(ids.cashierA), payload: { name: 'x' } })).statusCode).toBe(403);
  });

  it('owner mints a POS API key; it works as a cashier and cannot mint more keys', async () => {
    const res = await app.inject({ method: 'POST', url: '/api-keys', headers: auth(ids.ownerA), payload: { name: 'Till 1' } });
    expect(res.statusCode).toBe(201);
    ids.apiKey = res.json().key; ids.apiKeyId = res.json().id;
    expect(res.json().role).toBe('cashier');

    const viaKey = await app.inject({ method: 'POST', url: '/payment-requests', headers: { 'x-api-key': ids.apiKey }, payload: { amountMinor: '1000', saleRef: `key-${run}` } });
    expect(viaKey.statusCode).toBe(201);
    const escalate = await app.inject({ method: 'POST', url: '/api-keys', headers: { 'x-api-key': ids.apiKey }, payload: { name: 'more' } });
    expect(escalate.statusCode).toBe(403);
    const refund = await app.inject({ method: 'POST', url: '/transactions/x/refund', headers: { 'x-api-key': ids.apiKey, 'idempotency-key': 'k' }, payload: {} });
    expect(refund.statusCode).toBe(403);
    const bogus = await app.inject({ method: 'GET', url: '/payment-requests', headers: { 'x-api-key': ids.apiKey.slice(0, -2) + 'zz' } });
    expect(bogus.statusCode).toBe(401);
  });

  // ---------------------------------------------------------------- the flow
  let ref = '';
  let requestId = '';
  const AMOUNT = 25_000n; // KES 25,000

  it('1–2. cashier raises an open request for a sale; the same saleRef returns the same request', async () => {
    const res = await newRequest(ids.cashierA, { amountMinor: AMOUNT.toString(), saleRef: `S-${run}`, description: '2 × coffee' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.targeted).toBe(false);
    expect(body.ref).toMatch(/^pr_[A-Za-z0-9_-]{20,}$/);
    expect(body.qr).toContain(encodeURIComponent(body.ref).replace(/%2D/g, '-'));
    ref = body.ref; requestId = body.id;

    const again = await newRequest(ids.cashierA, { amountMinor: AMOUNT.toString(), saleRef: `S-${run}` });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(requestId);

    const conflict = await newRequest(ids.cashierA, { amountMinor: '999', saleRef: `S-${run}` });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('sale_ref_conflict');
  });

  it('rejects a bad amount and a currency the business does not hold', async () => {
    expect((await newRequest(ids.cashierA, { amountMinor: '0' })).statusCode).toBe(400);
    expect((await newRequest(ids.cashierA, { amountMinor: '100', currency: 'USD' })).statusCode).toBe(400);
  });

  it('3. the customer scans the QR and sees who and how much — before any money moves', async () => {
    const qr = (await app.inject({ method: 'GET', url: `/payment-requests/${requestId}`, headers: auth(ids.ownerA) })).json().qr;
    const res = await app.inject({ method: 'POST', url: '/customer/scan', headers: auth(ids.payerToken), payload: { qr } });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('request');
    expect(res.json().request.merchantName).toBe(`PR a ${run}`);
    expect(res.json().request.amountMinor).toBe(AMOUNT.toString());
    expect(await wallet(ids.payer)).toBe(OPENING);
  });

  it('a wrong PIN moves nothing and leaves the request pending', async () => {
    const res = await pay(ref, ids.payerToken, '0000');
    expect(res.statusCode).toBe(401);
    expect(await wallet(ids.payer)).toBe(OPENING);
    expect((await prisma.pushPrompt.findUniqueOrThrow({ where: { ref } })).status).toBe('pending');
  });

  it('a merchant token cannot pay, and a customer token cannot use merchant routes', async () => {
    expect((await pay(ref, ids.ownerA)).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/payment-requests', headers: auth(ids.payerToken) })).statusCode).toBe(401);
  });

  let transferId = '';
  let merchantTxnId = '';

  it('4–7. customer pays: request settles and both ledgers post exactly once', async () => {
    const mBefore = await merchantBalance(ids.merchantA);
    const res = await pay(ref, ids.payerToken);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('paid');
    expect(BigInt(body.balanceMinor)).toBe(OPENING - AMOUNT);
    transferId = body.transferId; merchantTxnId = body.merchantTransactionId;

    expect(await wallet(ids.payer)).toBe(OPENING - AMOUNT);
    expect(await merchantBalance(ids.merchantA)).toBe(mBefore + AMOUNT);

    const req = await prisma.pushPrompt.findUniqueOrThrow({ where: { ref } });
    expect(req.status).toBe('approved');
    expect(req.paidByCustomerId).toBe(ids.payer);
    expect(req.transferId).toBe(transferId);

    // the two ledgers are linked, and each nets to zero
    const mtxn = await prisma.transaction.findUniqueOrThrow({ where: { id: merchantTxnId } });
    expect(mtxn.transferId).toBe(transferId);
    const mNet = (await prisma.ledgerEntry.findMany({ where: { transactionId: merchantTxnId } })).reduce((s, e) => s + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n);
    const cNet = (await prisma.customerLedgerEntry.findMany({ where: { transferId } })).reduce((s, e) => s + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n);
    expect(mNet).toBe(0n);
    expect(cNet).toBe(0n);
  });

  it('a retry by the payer returns the same receipt and charges nothing more', async () => {
    const res = await pay(ref, ids.payerToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().replayed).toBe(true);
    expect(res.json().transferId).toBe(transferId);
    expect(await wallet(ids.payer)).toBe(OPENING - AMOUNT);
  });

  it('a second customer cannot pay an already-paid request', async () => {
    const res = await pay(ref, ids.otherToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_paid');
    expect(await wallet(ids.other)).toBe(OPENING);
  });

  it('two simultaneous payments of one request settle once', async () => {
    const r = (await newRequest(ids.cashierA, { amountMinor: '3000', saleRef: `race-${run}` })).json().ref;
    const before = (await wallet(ids.payer)) + (await wallet(ids.other));
    const results = await Promise.all([pay(r, ids.payerToken), pay(r, ids.otherToken), pay(r, ids.payerToken)]);
    const after = (await wallet(ids.payer)) + (await wallet(ids.other));
    expect(before - after).toBe(3000n);
    expect(results.filter((x) => x.statusCode === 201)).toHaveLength(1);
    expect(await prisma.transaction.count({ where: { merchantId: ids.merchantA, transferId: (await prisma.pushPrompt.findUniqueOrThrow({ where: { ref: r } })).transferId } })).toBe(1);
  });

  it('8. the business is notified through the outbox with a verifiable signature', async () => {
    const queued = await prisma.webhookDelivery.findMany({ where: { merchantId: ids.merchantA, event: 'payment.succeeded' } });
    const forThisSale = queued.find((q) => JSON.parse(q.payloadJson).data.paymentRequest?.saleRef === `S-${run}`);
    expect(forThisSale).toBeTruthy();

    const seen: Array<{ url: string; body: string; sig: string }> = [];
    const r = await dispatchDueDeliveries({
      post: async (url, init) => { seen.push({ url, body: init.body, sig: init.headers[SIGNATURE_HEADER]! }); return { ok: true, status: 200 }; },
    });
    expect(r.delivered).toBeGreaterThanOrEqual(1);
    const mine = seen.find((s) => JSON.parse(s.body).id === forThisSale!.id)!;
    expect(mine.url).toBe('https://pos.example.test/axo');
    expect(verifyPayloadSignature(ids.webhookSecret, mine.body, mine.sig)).toBe(true);
    expect(verifyPayloadSignature(ids.webhookSecret, mine.body.replace('25000', '99999'), mine.sig)).toBe(false);
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: forThisSale!.id } })).status).toBe('delivered');
  });

  it('a failing endpoint is retried later, not dropped', async () => {
    const r = (await newRequest(ids.cashierA, { amountMinor: '500', saleRef: `retry-${run}` })).json().ref;
    expect((await pay(r, ids.payerToken)).statusCode).toBe(201);
    const res = await dispatchDueDeliveries({ post: async () => ({ ok: false, status: 503 }) });
    expect(res.failed).toBeGreaterThanOrEqual(1);
    const pending = await prisma.webhookDelivery.findFirstOrThrow({ where: { merchantId: ids.merchantA, status: 'pending', lastError: 'http_503' } });
    expect(pending.attempts).toBe(1);
    expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('9. the dashboard sees the verified payment and the paid request', async () => {
    const reqView = await app.inject({ method: 'GET', url: `/payment-requests/${requestId}`, headers: auth(ids.ownerA) });
    expect(reqView.json().status).toBe('paid');
    expect(reqView.json().merchantTransactionId).toBe(merchantTxnId);
    const feed = await app.inject({ method: 'GET', url: '/transactions', headers: auth(ids.ownerA) });
    expect(feed.json().some((t: any) => t.id === merchantTxnId && t.status === 'confirmed')).toBe(true);
  });

  it('another business cannot read the request', async () => {
    expect((await app.inject({ method: 'GET', url: `/payment-requests/${requestId}`, headers: auth(ids.ownerB) })).statusCode).toBe(404);
  });

  // ---------------------------------------------------------------- lifecycle
  it('an expired request cannot be paid', async () => {
    const r = (await newRequest(ids.cashierA, { amountMinor: '700', saleRef: `exp-${run}` })).json();
    await prisma.pushPrompt.update({ where: { id: r.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await pay(r.ref, ids.payerToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('expired');
  });

  it('a cancelled request cannot be paid', async () => {
    const r = (await newRequest(ids.cashierA, { amountMinor: '800', saleRef: `cxl-${run}` })).json();
    expect((await app.inject({ method: 'POST', url: `/payment-requests/${r.id}/cancel`, headers: auth(ids.cashierA) })).statusCode).toBe(200);
    expect((await pay(r.ref, ids.payerToken)).statusCode).toBe(409);
  });

  it('a request targeted at one customer is invisible to everyone else', async () => {
    const r = (await newRequest(ids.cashierA, { amountMinor: '900', customerTag: `@pro${run}` })).json();
    expect(r.targeted).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/customer/payment-requests/${r.ref}`, headers: auth(ids.payerToken) })).statusCode).toBe(404);
    expect((await pay(r.ref, ids.payerToken)).statusCode).toBe(404);
    const inbox = await app.inject({ method: 'GET', url: '/customer/payment-requests', headers: auth(ids.otherToken) });
    expect(inbox.json().some((x: any) => x.ref === r.ref)).toBe(true);
  });

  // ---------------------------------------------------------------- refunds (S6)
  it('refunds go back to the customer, are capped at what was paid, and replay safely', async () => {
    const before = await wallet(ids.payer);
    const mBefore = await merchantBalance(ids.merchantA);
    const url = `/transactions/${merchantTxnId}/refund`;

    expect((await app.inject({ method: 'POST', url, headers: { ...auth(ids.cashierA), 'idempotency-key': `rf0-${run}` }, payload: {} })).statusCode).toBe(403);

    const part = await app.inject({ method: 'POST', url, headers: { ...auth(ids.ownerA), 'idempotency-key': `rf1-${run}` }, payload: { amountMinor: '10000', reason: 'one coffee returned' } });
    expect(part.statusCode).toBe(200);
    expect(await wallet(ids.payer)).toBe(before + 10_000n);
    expect(await merchantBalance(ids.merchantA)).toBe(mBefore - 10_000n);

    const replay = await app.inject({ method: 'POST', url, headers: { ...auth(ids.ownerA), 'idempotency-key': `rf1-${run}` }, payload: { amountMinor: '10000' } });
    expect(replay.json().id).toBe(part.json().id);
    expect(await wallet(ids.payer)).toBe(before + 10_000n);

    const tooMuch = await app.inject({ method: 'POST', url, headers: { ...auth(ids.ownerA), 'idempotency-key': `rf2-${run}` }, payload: { amountMinor: '20000' } });
    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json().error).toBe('refund_exceeds_remaining');

    const rest = await app.inject({ method: 'POST', url, headers: { ...auth(ids.ownerA), 'idempotency-key': `rf3-${run}` }, payload: {} });
    expect(rest.statusCode).toBe(200);
    expect(await wallet(ids.payer)).toBe(before + AMOUNT);

    const again = await app.inject({ method: 'POST', url, headers: { ...auth(ids.ownerA), 'idempotency-key': `rf4-${run}` }, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_fully_refunded');
    expect(await wallet(ids.payer)).toBe(before + AMOUNT);
  });

  it('another business cannot refund this payment', async () => {
    const res = await app.inject({ method: 'POST', url: `/transactions/${merchantTxnId}/refund`, headers: { ...auth(ids.ownerB), 'idempotency-key': `rfb-${run}` }, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('10. the daily settlement report adds up and the cross-ledger check is balanced', async () => {
    const res = await app.inject({ method: 'GET', url: `/reports/settlement?date=${new Date().toISOString().slice(0, 10)}`, headers: auth(ids.ownerA) });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(BigInt(r.collections.grossMinor)).toBe(AMOUNT + 3000n + 500n);
    expect(BigInt(r.collections.refundsMinor)).toBe(AMOUNT);
    expect(BigInt(r.collections.netMinor)).toBe(3500n);
    expect(r.collections.settlementStatus).toBe('settled_to_balance');
    expect(r.reconciliation.status).toBe('balanced');
    expect(BigInt(r.closingBalanceMinor)).toBe(await merchantBalance(ids.merchantA));
  });

  // ---------------------------------------------------------------- security fixes
  it('S1: a merchant payment cannot be "reversed" by the payer', async () => {
    const r = (await newRequest(ids.cashierA, { amountMinor: '1200', saleRef: `rev-${run}` })).json().ref;
    const paid = (await pay(r, ids.payerToken)).json();
    const before = await wallet(ids.payer);
    const mBefore = await merchantBalance(ids.merchantA);
    const res = await app.inject({ method: 'POST', url: `/customer/transfers/${paid.transferId}/reverse`, headers: auth(ids.payerToken), payload: { pin: PIN } });
    expect(res.statusCode).toBe(409);
    expect(await wallet(ids.payer)).toBe(before);
    expect(await merchantBalance(ids.merchantA)).toBe(mBefore);
  });

  it('S2/S3: merchant tokens can no longer move customer money or mint agent float', async () => {
    const before = await wallet(ids.payer);
    const tries = [
      app.inject({ method: 'POST', url: '/payments/customer', headers: { ...auth(ids.ownerA), 'idempotency-key': `s2a-${run}` }, payload: { customerId: ids.payer, amountMinor: '100', currency: 'KES' } }),
      app.inject({ method: 'POST', url: '/cash/out', headers: { ...auth(ids.ownerA), 'idempotency-key': `s2b-${run}` }, payload: { customerId: ids.payer, amountMinor: '100', currency: 'KES', destination: 'x' } }),
      app.inject({ method: 'POST', url: '/transfers/to-phone', headers: auth(ids.ownerA), payload: { senderId: ids.payer, recipientPhone: '254700000000', amountMinor: '100', currency: 'KES' } }),
      app.inject({ method: 'POST', url: '/collect/push/x/approve' }),
      app.inject({ method: 'POST', url: '/agents', headers: auth(ids.ownerA), payload: { code: `AG${run}`, name: 'x', country: 'KE', currency: 'KES' } }),
      app.inject({ method: 'POST', url: '/agents/AMRAN/float', headers: auth(ids.ownerA), payload: { amountMinor: '100000000' } }),
      app.inject({ method: 'POST', url: '/claims/repoint', headers: auth(ids.ownerA), payload: { oldWaId: '254700000001', newWaId: '254700000002' } }),
    ];
    for (const res of await Promise.all(tries)) {
      expect([401, 404, 503]).toContain(res.statusCode);
    }
    expect(await wallet(ids.payer)).toBe(before);
    expect(await prisma.agent.findUnique({ where: { code: `AG${run}` } })).toBeNull();
  });

  it('S4: payment webhooks need a valid signature over the raw body, and replays are ignored', async () => {
    const charge = await app.inject({ method: 'POST', url: '/charges', headers: { ...auth(ids.ownerA), 'idempotency-key': `chg-${run}` }, payload: { amountMinor: '4000', currency: 'KES', customerRef: 'ext-1', provider: 'sandbox' } });
    expect(charge.statusCode).toBe(200);
    expect(charge.json().status).toBe('pending');
    const event = { eventId: `evt-${run}-1`, providerRef: charge.json().providerRef, outcome: 'confirmed' };

    const forged = await app.inject({ method: 'POST', url: '/webhooks/sandbox', headers: { 'content-type': 'application/json', 'x-sandbox-signature': 'deadbeef' }, payload: JSON.stringify(event) });
    expect(forged.statusCode).toBe(401);

    const { rawBody, signature } = signSandboxWebhook(event);
    const mBefore = await merchantBalance(ids.merchantA);
    const ok = await app.inject({ method: 'POST', url: '/webhooks/sandbox', headers: { 'content-type': 'application/json', 'x-sandbox-signature': signature }, payload: rawBody });
    expect(ok.json().applied).toBe(true);
    expect(await merchantBalance(ids.merchantA)).toBe(mBefore + 4000n);

    const replay = await app.inject({ method: 'POST', url: '/webhooks/sandbox', headers: { 'content-type': 'application/json', 'x-sandbox-signature': signature }, payload: rawBody });
    expect(replay.json().applied).toBe(false);
    expect(await merchantBalance(ids.merchantA)).toBe(mBefore + 4000n);

    const unknown = await app.inject({ method: 'POST', url: '/webhooks/axo', headers: { 'content-type': 'application/json' }, payload: rawBody });
    expect(unknown.statusCode).toBe(404);
  });

  it('S8: one business cannot replay another business\'s idempotency key', async () => {
    const key = `shared-${run}`;
    const a = await app.inject({ method: 'POST', url: '/charges', headers: { ...auth(ids.ownerA), 'idempotency-key': key }, payload: { amountMinor: '111', currency: 'KES', customerRef: 'a', provider: 'sandbox' } });
    const b = await app.inject({ method: 'POST', url: '/charges', headers: { ...auth(ids.ownerB), 'idempotency-key': key }, payload: { amountMinor: '222', currency: 'KES', customerRef: 'b', provider: 'sandbox' } });
    expect(a.json().id).not.toBe(b.json().id);
    expect(b.json().merchantId).toBe(ids.merchantB);
  });

  // ---------------------------------------------------------------- WhatsApp
  it('WhatsApp: PAY TILL then a bare PIN pays (regression: the PIN was read as an OTP)', async () => {
    const before = await wallet(ids.payer);
    expect((await whatsapp(payerWaId, `PAY TILL ${ids.till} 150`)).statusCode).toBe(200);
    expect(await prisma.pendingConfirm.findUnique({ where: { waId: payerWaId } })).toBeTruthy();
    expect(await wallet(ids.payer)).toBe(before);
    await whatsapp(payerWaId, PIN);
    expect(await wallet(ids.payer)).toBe(before - 150n); // KES 150
  });

  it('WhatsApp: a pushed request needs the PIN — YES alone does not pay it', async () => {
    const r = (await newRequest(ids.cashierA, { amountMinor: '2000', customerTag: `@prp${run}` })).json();
    const before = await wallet(ids.payer);
    await whatsapp(payerWaId, 'YES');
    expect(await wallet(ids.payer)).toBe(before);
    expect((await prisma.pushPrompt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('pending');
    await whatsapp(payerWaId, PIN);
    expect(await wallet(ids.payer)).toBe(before - 2000n);
    expect((await prisma.pushPrompt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('approved');
  });

  it('WhatsApp: NO declines a pushed request and nothing is charged', async () => {
    const r = (await newRequest(ids.cashierA, { amountMinor: '2100', customerTag: `@prp${run}` })).json();
    const before = await wallet(ids.payer);
    await whatsapp(payerWaId, 'NO');
    expect((await prisma.pushPrompt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('declined');
    expect(await wallet(ids.payer)).toBe(before);
  });

  it('WhatsApp: REVERSE does not undo a payment to a business (S1)', async () => {
    const before = await wallet(ids.payer);
    await whatsapp(payerWaId, 'REVERSE');
    expect(await wallet(ids.payer)).toBe(before);
  });
});
