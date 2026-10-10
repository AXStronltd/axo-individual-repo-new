import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory DB for the claimable-transfer flow. Proves:
//  - send-to-unregistered reserves the sender's funds and issues a code
//  - claiming by the original number provisions a wallet and moves the money
//  - claiming by VERIFIED IDENTITY (lost phone / new number) settles to the
//    recovered account even though the number does not match
//  - re-pointing pending claims moves an unclaimed send to a new number
//  - the customer ledger always nets to zero
//  - an already-claimed code is idempotent (no double pay)

const store = {
  customers: new Map<string, any>(),
  wallets: new Map<string, any>(),
  waLinks: new Map<string, any>(), // waId -> { waId, customerId }
  claims: new Map<string, any>(), // code -> claimable transfer
  ledger: [] as any[],
  seq: 0,
};

function resetStore() {
  store.customers.clear();
  store.wallets.clear();
  store.waLinks.clear();
  store.claims.clear();
  store.ledger = [];
  store.seq = 0;
  const mk = (id: string, bal: bigint, opts: { waId?: string; status?: string } = {}) => {
    const wid = 'w_' + id;
    store.wallets.set(wid, { id: wid, customerId: id, currency: 'KES', balanceMinor: bal, reservedMinor: 0n });
    store.customers.set(id, {
      id, axoTag: '@' + id, displayName: id, country: 'KE', currency: 'KES',
      status: opts.status ?? 'active', kycTier: 'verified', walletId: wid,
    });
    if (opts.waId) store.waLinks.set(opts.waId, { waId: opts.waId, customerId: id });
  };
  mk('alice', 100000n, { waId: '254700000001' }); // sender
  mk('recovered', 0n, { waId: '254700000999' });   // the recipient, now on a NEW number
}

const fakeTx: any = {
  claimableTransfer: {
    findUnique: async ({ where }: any) =>
      where.code ? store.claims.get(where.code) ?? null
        : [...store.claims.values()].find((c) => c.idempotencyKey && c.idempotencyKey === where.idempotencyKey) ?? null,
    findMany: async ({ where }: any) => {
      let rows = [...store.claims.values()];
      if (where?.recipientWaId) rows = rows.filter((c) => c.recipientWaId === where.recipientWaId);
      if (where?.status) rows = rows.filter((c) => c.status === where.status);
      return rows.map((c) => ({ id: c.id }));
    },
    create: async ({ data }: any) => {
      const id = 'clm_' + ++store.seq;
      const row = { id, claimedAt: null, ...data };
      store.claims.set(data.code, row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = { ...[...store.claims.values()].find((c) => c.id === where.id || c.code === where.code), ...data };
      store.claims.set(row.code, row);
      return row;
    },
  },
  whatsAppLink: {
    findUnique: async ({ where }: any) => {
      const link = store.waLinks.get(where.waId);
      if (!link) return null;
      const c = store.customers.get(link.customerId);
      return { ...link, customer: { ...c, wallet: store.wallets.get(c.walletId) } };
    },
  },
  customer: {
    findUniqueOrThrow: async ({ where }: any) => {
      const c = store.customers.get(where.id);
      if (!c) throw new Error('not found');
      return { ...c, wallet: store.wallets.get(c.walletId) };
    },
    findUnique: async ({ where }: any) => {
      const c = store.customers.get(where.id);
      return c ? { ...c, wallet: store.wallets.get(c.walletId) } : null;
    },
    create: async ({ data }: any) => {
      const id = 'cust_' + ++store.seq;
      const wid = 'w_' + id;
      const wallet = { id: wid, customerId: id, currency: data.currency, balanceMinor: 0n, reservedMinor: 0n };
      store.wallets.set(wid, wallet);
      store.customers.set(id, { id, axoTag: data.axoTag, displayName: data.displayName, country: data.country, currency: data.currency, status: data.status, kycTier: 'basic', walletId: wid });
      if (data.waLink?.create) store.waLinks.set(data.waLink.create.waId, { waId: data.waLink.create.waId, customerId: id });
      return { ...store.customers.get(id), wallet };
    },
  },
  customerAccount: {
    findFirstOrThrow: async ({ where }: any) => {
      const w = [...store.wallets.values()].find((w) => w.customerId === where.customerId);
      if (!w) throw new Error('no wallet');
      return w;
    },
    update: async ({ where, data }: any) => {
      const w = store.wallets.get(where.id);
      if (data.balanceMinor?.increment !== undefined) w.balanceMinor += data.balanceMinor.increment;
      if (data.reservedMinor?.increment !== undefined) w.reservedMinor += data.reservedMinor.increment;
      if (data.reservedMinor?.decrement !== undefined) w.reservedMinor -= data.reservedMinor.decrement;
      return w;
    },
  },
  customerLedgerEntry: {
    create: async ({ data }: any) => { store.ledger.push(data); return data; },
  },
  denylistEntry: { findMany: async () => [] },
};

vi.mock('../src/db/client.js', () => ({
  prisma: {
    claimableTransfer: {
      findMany: (args: any) => fakeTx.claimableTransfer.findMany(args),
      update: (args: any) => fakeTx.claimableTransfer.update(args),
    },
  },
  inTransaction: (fn: any) => fn(fakeTx),
}));

const { sendToUnregistered, claimTransfer, claimByIdentity, repointClaimsToNewNumber } =
  await import('../src/modules/p2p/claim.service.js');

function ledgerNet() {
  return store.ledger.reduce((n, e) => n + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n);
}

describe('claimable transfers (send to a phone, claim later)', () => {
  beforeEach(resetStore);

  it('sendToUnregistered reserves funds and issues a claim code', async () => {
    const ct = await sendToUnregistered({ senderId: 'alice', recipientPhone: '254711222333', amountMinor: 5000n, currency: 'KES' });
    expect(ct.status).toBe('unclaimed');
    expect(ct.code).toMatch(/^CLM-\d{6}$/);
    expect(store.wallets.get('w_alice').reservedMinor).toBe(5000n);
    expect(store.wallets.get('w_alice').balanceMinor).toBe(100000n); // not moved yet
  });

  it('claim by the original number provisions a wallet and moves the money', async () => {
    const ct = await sendToUnregistered({ senderId: 'alice', recipientPhone: '254711222333', amountMinor: 5000n, currency: 'KES' });
    const r = await claimTransfer({ code: ct.code, recipientWaId: '254711222333' });
    expect(r.status).toBe('claimed');
    expect(store.wallets.get('w_alice').reservedMinor).toBe(0n);
    expect(store.wallets.get('w_alice').balanceMinor).toBe(95000n);
    expect(ledgerNet()).toBe(0n);
  });

  it('a wrong number cannot claim', async () => {
    const ct = await sendToUnregistered({ senderId: 'alice', recipientPhone: '254711222333', amountMinor: 5000n, currency: 'KES' });
    const r: any = await claimTransfer({ code: ct.code, recipientWaId: '254799999999' });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('wrong_recipient');
  });

  it('an already-claimed code is idempotent (no double pay)', async () => {
    const ct = await sendToUnregistered({ senderId: 'alice', recipientPhone: '254711222333', amountMinor: 5000n, currency: 'KES' });
    await claimTransfer({ code: ct.code, recipientWaId: '254711222333' });
    const again = await claimTransfer({ code: ct.code, recipientWaId: '254711222333' });
    expect(again.status).toBe('claimed');
    expect(store.wallets.get('w_alice').balanceMinor).toBe(95000n); // charged once
  });
});

describe('claimByIdentity (lost phone — claim on a recovered account)', () => {
  beforeEach(resetStore);

  it('settles to the verified account even though the number does not match', async () => {
    // money was sent to a number the recipient has since lost
    const ct = await sendToUnregistered({ senderId: 'alice', recipientPhone: '254788888888', amountMinor: 7000n, currency: 'KES' });
    // the number no longer matches, so a plain claim is refused
    const plain: any = await claimTransfer({ code: ct.code, recipientWaId: '254700000999' });
    expect(plain.status).toBe('rejected');
    // but identity is the authority: the recovered customer claims it
    const r: any = await claimByIdentity({ code: ct.code, customerId: 'recovered' });
    expect(r.status).toBe('claimed');
    expect(r.recipientId).toBe('recovered');
    expect(store.wallets.get('w_recovered').balanceMinor).toBe(7000n);
    expect(store.wallets.get('w_alice').reservedMinor).toBe(0n);
    expect(ledgerNet()).toBe(0n);
  });

  it('a frozen account cannot claim by identity', async () => {
    store.customers.get('recovered').status = 'frozen';
    const ct = await sendToUnregistered({ senderId: 'alice', recipientPhone: '254788888888', amountMinor: 7000n, currency: 'KES' });
    const r: any = await claimByIdentity({ code: ct.code, customerId: 'recovered' });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('account_frozen');
    expect(store.wallets.get('w_recovered').balanceMinor).toBe(0n);
  });

  it('an unknown code is rejected', async () => {
    const r: any = await claimByIdentity({ code: 'CLM-000000', customerId: 'recovered' });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('unknown_code');
  });
});

describe('repointClaimsToNewNumber (recovery / number change)', () => {
  beforeEach(resetStore);

  it('moves pending unclaimed money from the old number to the new one', async () => {
    const ct = await sendToUnregistered({ senderId: 'alice', recipientPhone: '254788888888', amountMinor: 3000n, currency: 'KES' });
    const r = await repointClaimsToNewNumber({ oldWaId: '254788888888', newWaId: '254700000999' });
    expect(r.repointed).toBe(1);
    // now the new number can claim it directly
    const claim: any = await claimTransfer({ code: ct.code, recipientWaId: '254700000999' });
    expect(claim.status).toBe('claimed');
  });

  it('re-points nothing when there is no pending money', async () => {
    const r = await repointClaimsToNewNumber({ oldWaId: '254712000000', newWaId: '254700000999' });
    expect(r.repointed).toBe(0);
  });
});
