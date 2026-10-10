import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB module so sendP2P runs its real logic against an in-memory store.
// This proves: balance moves correctly, the customer ledger balances, limits are
// enforced, and a repeated idempotency key never double-sends.

const store = {
  customers: new Map<string, any>(),
  wallets: new Map<string, any>(),
  transfers: new Map<string, any>(),
  ledger: [] as any[],
  seq: 0,
};

function resetStore() {
  store.customers.clear();
  store.wallets.clear();
  store.transfers.clear();
  store.ledger = [];
  store.seq = 0;
  const mk = (id: string, bal: bigint, status = 'active', tier = 'basic') => {
    const wid = 'w_' + id;
    store.wallets.set(wid, { id: wid, customerId: id, currency: 'KES', balanceMinor: bal, reservedMinor: 0n });
    store.customers.set(id, { id, axoTag: '@' + id, status, kycTier: tier, currency: 'KES', walletId: wid });
  };
  mk('alice', 100000n);
  mk('bob', 0n);
}

const fakeTx = {
  p2PTransfer: {
    findUnique: async ({ where }: any) =>
      where.idempotencyKey
        ? [...store.transfers.values()].find((t) => t.idempotencyKey === where.idempotencyKey) ?? null
        : store.transfers.get(where.id) ?? null,
    findMany: async ({ where }: any) => {
      let rows = [...store.transfers.values()];
      if (where?.senderId) rows = rows.filter((t) => t.senderId === where.senderId);
      if (where?.status?.in) rows = rows.filter((t) => where.status.in.includes(t.status));
      return rows;
    },
    create: async ({ data }: any) => {
      const id = 'xfer_' + ++store.seq;
      const row = { id, completedAt: null, ...data };
      store.transfers.set(id, row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = { ...store.transfers.get(where.id), ...data };
      store.transfers.set(where.id, row);
      return row;
    },
  },
  customer: {
    findUniqueOrThrow: async ({ where }: any) => {
      const c = store.customers.get(where.id);
      if (!c) throw new Error('not found');
      return { ...c, wallet: store.wallets.get(c.walletId) };
    },
    // risk.screenMovement looks up the sender's tag
    findUnique: async ({ where }: any) => {
      const c = store.customers.get(where.id);
      return c ? { ...c, wallet: store.wallets.get(c.walletId) } : null;
    },
  },
  // risk.screenMovement reads the denylist (empty in these tests)
  denylistEntry: {
    findMany: async () => [],
  },
  customerLedgerEntry: {
    create: async ({ data }: any) => {
      store.ledger.push(data);
      return data;
    },
  },
  customerAccount: {
    update: async ({ where, data }: any) => {
      const w = store.wallets.get(where.id);
      w.balanceMinor += data.balanceMinor.increment;
      return w;
    },
  },
};

vi.mock('../src/db/client.js', () => ({
  prisma: {},
  inTransaction: (fn: any) => fn(fakeTx),
}));

const { sendP2P } = await import('../src/modules/p2p/p2p.service.js');

describe('sendP2P (service, in-memory DB)', () => {
  beforeEach(resetStore);

  it('moves money and keeps the customer ledger balanced', async () => {
    const t = await sendP2P({ senderId: 'alice', recipientId: 'bob', amountMinor: 30000n, currency: 'KES' });
    expect(t.status).toBe('completed');
    expect(store.wallets.get('w_alice').balanceMinor).toBe(70000n);
    expect(store.wallets.get('w_bob').balanceMinor).toBe(30000n);
    // ledger nets to zero
    const net = store.ledger.reduce((n, e) => n + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n);
    expect(net).toBe(0n);
  });

  it('rejects insufficient funds without moving money', async () => {
    await expect(sendP2P({ senderId: 'alice', recipientId: 'bob', amountMinor: 999999n, currency: 'KES' })).rejects.toThrow(/insufficient/);
    expect(store.wallets.get('w_alice').balanceMinor).toBe(100000n);
    expect(store.wallets.get('w_bob').balanceMinor).toBe(0n);
  });

  it('is idempotent — a repeated key never double-sends', async () => {
    const a = await sendP2P({ senderId: 'alice', recipientId: 'bob', amountMinor: 20000n, currency: 'KES', idempotencyKey: 'k1' });
    const b = await sendP2P({ senderId: 'alice', recipientId: 'bob', amountMinor: 20000n, currency: 'KES', idempotencyKey: 'k1' });
    expect(b.id).toBe(a.id);
    expect(store.wallets.get('w_alice').balanceMinor).toBe(80000n); // charged once
    expect(store.wallets.get('w_bob').balanceMinor).toBe(20000n);
  });

  it('blocks sending to yourself', async () => {
    await expect(sendP2P({ senderId: 'alice', recipientId: 'alice', amountMinor: 1000n, currency: 'KES' })).rejects.toThrow(/yourself/);
  });
});
