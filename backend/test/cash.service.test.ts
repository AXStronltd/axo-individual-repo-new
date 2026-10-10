import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SandboxRampProvider } from '../src/providers/ramp.sandbox.js';

// In-memory store + fakes to run the real cash.service logic without a DB.
const store = {
  customers: new Map<string, any>(),
  wallets: new Map<string, any>(),
  cash: new Map<string, any>(),
  ledger: [] as any[],
  seq: 0,
};
function reset() {
  store.customers.clear(); store.wallets.clear(); store.cash.clear(); store.ledger = []; store.seq = 0;
  const wid = 'w_amina';
  store.wallets.set(wid, { id: wid, customerId: 'amina', currency: 'KES', balanceMinor: 100000n, reservedMinor: 0n });
  store.customers.set('amina', { id: 'amina', axoTag: '@amina', status: 'active', kycTier: 'verified', country: 'KE', currency: 'KES', walletId: wid });
}

const fakeTx: any = {
  customer: {
    findUniqueOrThrow: async ({ where }: any) => {
      // by id or by axoTag (clearing lookup uses axoTag via findUnique below)
      const c = store.customers.get(where.id);
      if (!c) throw new Error('not found');
      return { ...c, wallet: store.wallets.get(c.walletId) };
    },
    findUnique: async ({ where }: any) => {
      if (where.axoTag) {
        const c = [...store.customers.values()].find((x) => x.axoTag === where.axoTag);
        return c ? { ...c, wallet: store.wallets.get(c.walletId) } : null;
      }
      const c = store.customers.get(where.id);
      return c ? { ...c, wallet: store.wallets.get(c.walletId) } : null;
    },
    create: async ({ data }: any) => {
      // clearing wallet creation
      const id = 'sys_' + ++store.seq; const wid = 'w_' + id;
      store.wallets.set(wid, { id: wid, customerId: id, currency: data.currency, balanceMinor: 0n, reservedMinor: 0n });
      const c = { id, axoTag: data.axoTag, status: 'active', kycTier: 'verified', country: 'XX', currency: data.currency, walletId: wid };
      store.customers.set(id, c);
      return { ...c, wallet: store.wallets.get(wid) };
    },
  },
  cashTransfer: {
    findUnique: async ({ where }: any) => {
      if (where.idempotencyKey) return [...store.cash.values()].find((c) => c.idempotencyKey === where.idempotencyKey) ?? null;
      if (where.provider_providerRef) return [...store.cash.values()].find((c) => c.provider === where.provider_providerRef.provider && c.providerRef === where.provider_providerRef.providerRef) ?? null;
      return store.cash.get(where.id) ?? null;
    },
    create: async ({ data }: any) => { const id = 'ct_' + ++store.seq; const row = { id, providerRef: null, confirmedAt: null, ...data }; store.cash.set(id, row); return row; },
    update: async ({ where, data }: any) => { const row = { ...store.cash.get(where.id), ...data }; store.cash.set(where.id, row); return row; },
  },
  customerLedgerEntry: { create: async ({ data }: any) => { store.ledger.push(data); return data; } },
  customerAccount: {
    update: async ({ where, data }: any) => {
      const w = where.id ? store.wallets.get(where.id) : [...store.wallets.values()].find((x) => x.customerId === where.customerId);
      if (data.balanceMinor?.increment !== undefined) w.balanceMinor += data.balanceMinor.increment;
      if (data.reservedMinor?.increment !== undefined) w.reservedMinor += data.reservedMinor.increment;
      if (data.reservedMinor?.decrement !== undefined) w.reservedMinor -= data.reservedMinor.decrement;
      return w;
    },
  },
  // risk.screenMovement, called inside startCashOut
  p2PTransfer: { findMany: async () => [] },
  denylistEntry: { findMany: async () => [] },
  riskCase: { create: async ({ data }: any) => ({ id: 'case', ...data }) },
};

const prismaFake: any = {
  customer: fakeTx.customer,
  p2PTransfer: fakeTx.p2PTransfer,
  denylistEntry: fakeTx.denylistEntry,
  riskCase: fakeTx.riskCase,
  cashTransfer: fakeTx.cashTransfer,
  customerAccount: fakeTx.customerAccount,
};

vi.mock('../src/db/client.js', () => ({
  prisma: prismaFake,
  inTransaction: (fn: any) => fn(fakeTx),
}));

const ramp = new SandboxRampProvider('secret');
vi.mock('../src/providers/ramp.registry.js', () => ({
  pickRamp: (_op: any, _country: any, currency: string) => (currency === 'KES' ? ramp : null),
  allRamps: () => [ramp],
  rampStatus: () => [],
}));

const { startCashIn, startCashOut, applyRampWebhook } = await import('../src/modules/cash/cash.service.js');

describe('cash-in', () => {
  beforeEach(reset);
  it('does NOT credit the wallet until the webhook confirms', async () => {
    const r: any = await startCashIn({ customerId: 'amina', amountMinor: 50000n, currency: 'KES', source: '254712' });
    expect(r.status).toBe('pending');
    expect(store.wallets.get('w_amina').balanceMinor).toBe(100000n); // unchanged
    // webhook confirms
    await applyRampWebhook({ provider: 'ramp-sandbox', providerRef: r.cashTransfer.providerRef, op: 'cash_in', outcome: 'confirmed' });
    expect(store.wallets.get('w_amina').balanceMinor).toBe(150000n); // credited now
    const net = store.ledger.reduce((n, e) => n + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n);
    expect(net).toBe(0n); // customer ledger balances (wallet credit vs clearing debit)
  });
  it('refuses when no ramp supports the currency', async () => {
    const r: any = await startCashIn({ customerId: 'amina', amountMinor: 1000n, currency: 'GBP', source: 'x' });
    expect(r.status).toBe('unavailable');
  });
});

describe('cash-out', () => {
  beforeEach(reset);
  it('reserves immediately and debits on confirm', async () => {
    const r: any = await startCashOut({ customerId: 'amina', amountMinor: 40000n, currency: 'KES', destination: '254712' });
    expect(r.status).toBe('pending');
    expect(store.wallets.get('w_amina').reservedMinor).toBe(40000n);
    expect(store.wallets.get('w_amina').balanceMinor).toBe(100000n); // not debited yet
    await applyRampWebhook({ provider: 'ramp-sandbox', providerRef: r.cashTransfer.providerRef, op: 'cash_out', outcome: 'confirmed' });
    expect(store.wallets.get('w_amina').balanceMinor).toBe(60000n); // debited
    expect(store.wallets.get('w_amina').reservedMinor).toBe(0n);   // reservation cleared
  });
  it('releases the reservation when the webhook fails', async () => {
    const r: any = await startCashOut({ customerId: 'amina', amountMinor: 40000n, currency: 'KES', destination: '254712' });
    await applyRampWebhook({ provider: 'ramp-sandbox', providerRef: r.cashTransfer.providerRef, op: 'cash_out', outcome: 'failed' });
    expect(store.wallets.get('w_amina').reservedMinor).toBe(0n);
    expect(store.wallets.get('w_amina').balanceMinor).toBe(100000n); // nothing left
  });
  it('blocks a cash-out that exceeds spendable balance', async () => {
    await expect(startCashOut({ customerId: 'amina', amountMinor: 999999n, currency: 'KES', destination: 'x' })).rejects.toThrow(/insufficient/);
  });
  it('a duplicate confirm webhook is a no-op', async () => {
    const r: any = await startCashOut({ customerId: 'amina', amountMinor: 30000n, currency: 'KES', destination: 'x' });
    await applyRampWebhook({ provider: 'ramp-sandbox', providerRef: r.cashTransfer.providerRef, op: 'cash_out', outcome: 'confirmed' });
    const balAfter = store.wallets.get('w_amina').balanceMinor;
    const again = await applyRampWebhook({ provider: 'ramp-sandbox', providerRef: r.cashTransfer.providerRef, op: 'cash_out', outcome: 'confirmed' });
    expect(again.applied).toBe(false);
    expect(store.wallets.get('w_amina').balanceMinor).toBe(balAfter); // not debited twice
  });
});
