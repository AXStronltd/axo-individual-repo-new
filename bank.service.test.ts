import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory DB for bank collection. Proves:
//  - an intent issues a unique reference and moves NO money
//  - confirming (auto or manual) credits the wallet and debits clearing
//  - the customer ledger nets to zero
//  - confirming the same reference twice is idempotent (no double credit)
//  - an unknown reference / currency mismatch / frozen account is refused

const store = {
  customers: new Map<string, any>(),
  wallets: new Map<string, any>(),
  intents: new Map<string, any>(), // reference -> intent
  cash: new Map<string, any>(),
  ledger: [] as any[],
  seq: 0,
};

function resetStore() {
  store.customers.clear();
  store.wallets.clear();
  store.intents.clear();
  store.cash.clear();
  store.ledger = [];
  store.seq = 0;
  const mk = (id: string, bal: bigint, status = 'active') => {
    const wid = 'w_' + id;
    store.wallets.set(wid, { id: wid, customerId: id, currency: 'USD', balanceMinor: bal, reservedMinor: 0n });
    store.customers.set(id, { id, axoTag: '@' + id, displayName: id, country: 'SO', currency: 'USD', status, kycTier: 'verified', walletId: wid });
  };
  mk('amina', 0n);
}

const fakeTx: any = {
  bankDepositIntent: {
    findUnique: async ({ where }: any) => store.intents.get(where.reference) ?? [...store.intents.values()].find((i) => i.id === where.id) ?? null,
    findFirst: async ({ where }: any) => [...store.intents.values()].find((i) =>
      i.customerId === where.customerId && i.status === where.status && i.amountMinor === where.amountMinor && i.currency === where.currency && i.bank === where.bank) ?? null,
    create: async ({ data }: any) => {
      if ([...store.intents.values()].some((i) => i.reference === data.reference)) { const e: any = new Error('unique'); e.code = 'P2002'; throw e; }
      const row = { id: 'int_' + ++store.seq, cashTransferId: null, confirmedMode: null, confirmedAt: null, ...data };
      store.intents.set(data.reference, row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = { ...[...store.intents.values()].find((i) => i.id === where.id), ...data };
      store.intents.set(row.reference, row);
      return row;
    },
  },
  customer: {
    findUniqueOrThrow: async ({ where }: any) => {
      const c = store.customers.get(where.id); if (!c) throw new Error('not found');
      return { ...c, wallet: store.wallets.get(c.walletId) };
    },
    findUnique: async ({ where }: any) => {
      if (where.axoTag) { const c = [...store.customers.values()].find((x) => x.axoTag === where.axoTag); return c ? { ...c, wallet: store.wallets.get(c.walletId) } : null; }
      const c = store.customers.get(where.id); return c ? { ...c, wallet: store.wallets.get(c.walletId) } : null;
    },
    create: async ({ data }: any) => {
      const id = 'cust_' + ++store.seq; const wid = 'w_' + id;
      store.wallets.set(wid, { id: wid, customerId: id, currency: data.currency, balanceMinor: 0n, reservedMinor: 0n });
      store.customers.set(id, { id, axoTag: data.axoTag, displayName: data.displayName, country: data.country, currency: data.currency, status: data.status, kycTier: 'verified', walletId: wid });
      return { ...store.customers.get(id), wallet: store.wallets.get(wid) };
    },
  },
  cashTransfer: {
    create: async ({ data }: any) => { const row = { id: 'ct_' + ++store.seq, ...data }; store.cash.set(row.id, row); return row; },
  },
  customerLedgerEntry: { create: async ({ data }: any) => { store.ledger.push(data); return data; } },
  customerAccount: {
    update: async ({ where, data }: any) => {
      const w = store.wallets.get(where.id);
      if (data.balanceMinor?.increment !== undefined) w.balanceMinor += data.balanceMinor.increment;
      return w;
    },
  },
};

vi.mock('../src/db/client.js', () => ({
  prisma: {
    customer: { findUniqueOrThrow: (a: any) => fakeTx.customer.findUniqueOrThrow(a) },
    bankDepositIntent: {
      findFirst: (a: any) => fakeTx.bankDepositIntent.findFirst(a),
      create: (a: any) => fakeTx.bankDepositIntent.create(a),
      findMany: async () => [],
      update: (a: any) => fakeTx.bankDepositIntent.update(a),
    },
  },
  inTransaction: (fn: any) => fn(fakeTx),
}));

const { createBankDepositIntent, confirmBankDeposit, cancelBankDepositIntent } = await import('../src/modules/cash/bank.service.js');

function ledgerNet() { return store.ledger.reduce((n, e) => n + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n); }

describe('bank collection — intent', () => {
  beforeEach(resetStore);

  it('issues a reference and moves no money', async () => {
    const intent = await createBankDepositIntent({ customerId: 'amina', amountMinor: 5000n, currency: 'USD', bank: 'galaxy' });
    expect(intent.status).toBe('awaiting');
    expect(intent.reference).toMatch(/^AXO-GALA-\d{6}$/);
    expect(store.wallets.get('w_amina').balanceMinor).toBe(0n); // nothing moved
  });

  it('rejects a non-positive amount', async () => {
    await expect(createBankDepositIntent({ customerId: 'amina', amountMinor: 0n, currency: 'USD', bank: 'galaxy' })).rejects.toThrow(/positive/);
  });
});

describe('bank collection — confirm (automated + manual)', () => {
  beforeEach(resetStore);

  it('automated webhook credits the wallet and balances the ledger', async () => {
    const intent = await createBankDepositIntent({ customerId: 'amina', amountMinor: 5000n, currency: 'USD', bank: 'galaxy' });
    const r: any = await confirmBankDeposit({ reference: intent.reference, amountMinor: 5000n, currency: 'USD', bankRef: 'GB-0001', mode: 'auto' });
    expect(r.applied).toBe(true);
    expect(store.wallets.get('w_amina').balanceMinor).toBe(5000n);
    expect(ledgerNet()).toBe(0n);
  });

  it('manual confirm credits the wallet the same way', async () => {
    const intent = await createBankDepositIntent({ customerId: 'amina', amountMinor: 3000n, currency: 'USD', bank: 'galaxy' });
    const r: any = await confirmBankDeposit({ reference: intent.reference, amountMinor: 3000n, currency: 'USD', mode: 'manual' });
    expect(r.applied).toBe(true);
    expect(store.wallets.get('w_amina').balanceMinor).toBe(3000n);
  });

  it('is idempotent — confirming the same reference twice credits once', async () => {
    const intent = await createBankDepositIntent({ customerId: 'amina', amountMinor: 5000n, currency: 'USD', bank: 'galaxy' });
    await confirmBankDeposit({ reference: intent.reference, amountMinor: 5000n, currency: 'USD', bankRef: 'GB-1', mode: 'auto' });
    const again: any = await confirmBankDeposit({ reference: intent.reference, amountMinor: 5000n, currency: 'USD', bankRef: 'GB-1', mode: 'auto' });
    expect(again.applied).toBe(false);
    expect(again.reason).toBe('already_credited');
    expect(store.wallets.get('w_amina').balanceMinor).toBe(5000n); // credited once
  });

  it('credits the amount the bank actually received, not the intent amount', async () => {
    const intent = await createBankDepositIntent({ customerId: 'amina', amountMinor: 5000n, currency: 'USD', bank: 'galaxy' });
    await confirmBankDeposit({ reference: intent.reference, amountMinor: 4800n, currency: 'USD', mode: 'manual' }); // bank received slightly less
    expect(store.wallets.get('w_amina').balanceMinor).toBe(4800n);
  });

  it('refuses an unknown reference', async () => {
    const r: any = await confirmBankDeposit({ reference: 'AXO-GALA-999999', amountMinor: 1000n, currency: 'USD', mode: 'auto' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('unknown_reference');
  });

  it('refuses a currency mismatch', async () => {
    const intent = await createBankDepositIntent({ customerId: 'amina', amountMinor: 5000n, currency: 'USD', bank: 'galaxy' });
    const r: any = await confirmBankDeposit({ reference: intent.reference, amountMinor: 5000n, currency: 'KES', mode: 'auto' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('currency_mismatch');
  });

  it('refuses a frozen account', async () => {
    store.customers.get('amina').status = 'frozen';
    // create directly (createBankDepositIntent would reject a frozen customer up front)
    store.intents.set('AXO-GALA-111111', { id: 'int_x', customerId: 'amina', amountMinor: 5000n, currency: 'USD', bank: 'galaxy', reference: 'AXO-GALA-111111', status: 'awaiting', cashTransferId: null });
    const r: any = await confirmBankDeposit({ reference: 'AXO-GALA-111111', amountMinor: 5000n, currency: 'USD', mode: 'auto' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('account_frozen');
  });
});

describe('bank collection — cancel', () => {
  beforeEach(resetStore);
  it('cancels an awaiting reference', async () => {
    const intent = await createBankDepositIntent({ customerId: 'amina', amountMinor: 5000n, currency: 'USD', bank: 'galaxy' });
    const r: any = await cancelBankDepositIntent({ reference: intent.reference });
    expect(r.ok).toBe(true);
    const after: any = await confirmBankDeposit({ reference: intent.reference, amountMinor: 5000n, currency: 'USD', mode: 'auto' });
    expect(after.applied).toBe(false); // can't confirm a cancelled intent
  });
});
