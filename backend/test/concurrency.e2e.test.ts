import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Money under concurrency, against a real Postgres.
 *
 * Every money movement runs in a SERIALIZABLE transaction, and Postgres aborts
 * one of two conflicting transactions (P2034) expecting the app to retry. Before
 * inTransaction retried, five customers paying one shop at the same moment saw
 * four of the five payments fail. These tests keep that fixed.
 * Skipped (not failed) when no database is reachable.
 */

const { prisma } = await import('../src/db/client.js');
const { payMerchant } = await import('../src/modules/p2p/p2p.service.js');

let dbUp = false;
try { await prisma.$queryRaw`SELECT 1`; dbUp = true; } catch { dbUp = false; }
const d = dbUp ? describe : describe.skip;

const run = randomUUID().replace(/-/g, '').slice(0, 10);
const N = 8;
let merchantId = '';
const customers: string[] = [];

const net = (rows: Array<{ direction: string; amountMinor: bigint }>) =>
  rows.reduce((s, e) => s + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n);

d('concurrent payments', () => {
  beforeAll(async () => {
    const m = await prisma.merchant.create({
      data: {
        legalName: `Busy Till ${run}`, tradingName: `Busy Till ${run}`, country: 'KE', currency: 'KES', axoId: `AXO-C${run}`,
        accounts: { create: [{ type: 'axo_balance', currency: 'KES' }, { type: 'clearing', currency: 'KES' }] },
      },
    });
    merchantId = m.id;
    for (let i = 0; i < N; i++) {
      const c = await prisma.customer.create({
        data: { axoTag: `@cc${i}${run}`, displayName: `C ${i}`, country: 'KE', currency: 'KES', status: 'active', kycTier: 'verified', wallet: { create: { currency: 'KES', balanceMinor: 1_000n } } },
      });
      customers.push(c.id);
    }
  });

  afterAll(async () => {
    const xfers = await prisma.p2PTransfer.findMany({ where: { senderId: { in: customers } } });
    for (const t of xfers) await prisma.customerLedgerEntry.deleteMany({ where: { transferId: t.id } });
    await prisma.p2PTransfer.deleteMany({ where: { id: { in: xfers.map((t) => t.id) } } });
    const txns = await prisma.transaction.findMany({ where: { merchantId } });
    for (const t of txns) await prisma.ledgerEntry.deleteMany({ where: { transactionId: t.id } });
    await prisma.transaction.deleteMany({ where: { merchantId } });
    await prisma.riskCase.deleteMany({ where: { subjectId: { in: [...customers, ...xfers.map((t) => t.id)] } } });
    await prisma.customerAccount.deleteMany({ where: { customerId: { in: customers } } });
    await prisma.customer.deleteMany({ where: { id: { in: customers } } });
    await prisma.account.deleteMany({ where: { merchantId } });
    await prisma.merchant.deleteMany({ where: { id: merchantId } });
  });

  it(`${N} customers paying one shop at the same moment all go through, exactly once each`, async () => {
    const results = await Promise.allSettled(customers.map((c) => payMerchant({ customerId: c, merchantId, amountMinor: 100n, currency: 'KES' })));
    const failed = results.filter((r) => r.status === 'rejected').map((r) => { const e = (r as PromiseRejectedResult).reason; return String(e?.code ?? "") + " " + String(e?.message ?? "").split("\n").filter(Boolean).pop()?.slice(0, 160); });
    expect(failed).toEqual([]);

    const shop = await prisma.account.findFirstOrThrow({ where: { merchantId, type: 'axo_balance', currency: 'KES' } });
    expect(shop.balanceMinor).toBe(100n * BigInt(N));
    for (const c of customers) {
      expect((await prisma.customerAccount.findUniqueOrThrow({ where: { customerId: c } })).balanceMinor).toBe(900n);
    }
    // both ledgers still net to zero per movement
    const txns = await prisma.transaction.findMany({ where: { merchantId, type: 'payment_in' } });
    expect(txns).toHaveLength(N);
    for (const t of txns) {
      expect(net(await prisma.ledgerEntry.findMany({ where: { transactionId: t.id } }))).toBe(0n);
      expect(net(await prisma.customerLedgerEntry.findMany({ where: { transferId: t.transferId! } }))).toBe(0n);
    }
  });

  it('the same payment submitted three times at once charges once, and every caller gets that receipt', async () => {
    const key = `dup-${run}`;
    const before = (await prisma.customerAccount.findUniqueOrThrow({ where: { customerId: customers[0]! } })).balanceMinor;
    const results = await Promise.all([0, 1, 2].map(() => payMerchant({ customerId: customers[0]!, merchantId, amountMinor: 50n, currency: 'KES', idempotencyKey: key })));
    expect(new Set(results.map((r) => r.transfer.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.merchantTransactionId)).size).toBe(1);
    const after = (await prisma.customerAccount.findUniqueOrThrow({ where: { customerId: customers[0]! } })).balanceMinor;
    expect(before - after).toBe(50n);
  });
});
