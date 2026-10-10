import { describe, it, expect, beforeEach } from 'vitest';
import { postLedger, ledgerBalance } from '../src/modules/ledger/ledger.service.js';

/**
 * In-memory fake of the slice of Prisma the ledger service uses, so the
 * invariant logic is tested without a database. The real integration tests
 * (see test/README.md) run the same service against Postgres.
 */
function makeFakeDb() {
  const accounts = new Map<string, { id: string; balanceMinor: bigint }>();
  const entries: { accountId: string; direction: 'debit' | 'credit'; amountMinor: bigint; currency: string }[] = [];
  return {
    _accounts: accounts,
    ledgerEntry: {
      create: async ({ data }: any) => {
        entries.push({
          accountId: data.accountId,
          direction: data.direction,
          amountMinor: data.amountMinor,
          currency: data.currency,
        });
        return data;
      },
      findMany: async ({ where }: any) => entries.filter((e) => e.accountId === where.accountId),
    },
    account: {
      update: async ({ where, data }: any) => {
        const acc = accounts.get(where.id)!;
        acc.balanceMinor += data.balanceMinor.increment as bigint;
        return acc;
      },
    },
  } as any;
}

let db: ReturnType<typeof makeFakeDb>;

beforeEach(() => {
  db = makeFakeDb();
  db._accounts.set('merchant', { id: 'merchant', balanceMinor: 0n });
  db._accounts.set('clearing', { id: 'clearing', balanceMinor: 0n });
});

describe('double-entry ledger invariants', () => {
  it('posts a balanced money-in and credits the merchant', async () => {
    await postLedger(
      'txn1',
      [
        { accountId: 'merchant', direction: 'credit', amountMinor: 5000n, currency: 'USD' },
        { accountId: 'clearing', direction: 'debit', amountMinor: 5000n, currency: 'USD' },
      ],
      db,
    );
    expect(db._accounts.get('merchant')!.balanceMinor).toBe(5000n);
    expect(db._accounts.get('clearing')!.balanceMinor).toBe(-5000n);
  });

  it('every posting nets to zero across accounts', async () => {
    await postLedger(
      'txn1',
      [
        { accountId: 'merchant', direction: 'credit', amountMinor: 5000n, currency: 'USD' },
        { accountId: 'clearing', direction: 'debit', amountMinor: 5000n, currency: 'USD' },
      ],
      db,
    );
    const total =
      db._accounts.get('merchant')!.balanceMinor + db._accounts.get('clearing')!.balanceMinor;
    expect(total).toBe(0n);
  });

  it('rejects an unbalanced posting (debits != credits)', async () => {
    await expect(
      postLedger(
        'bad',
        [
          { accountId: 'merchant', direction: 'credit', amountMinor: 5000n, currency: 'USD' },
          { accountId: 'clearing', direction: 'debit', amountMinor: 4000n, currency: 'USD' },
        ],
        db,
      ),
    ).rejects.toThrow(/do not balance/);
  });

  it('rejects a single-leg posting', async () => {
    await expect(
      postLedger('bad', [{ accountId: 'merchant', direction: 'credit', amountMinor: 1n, currency: 'USD' }], db),
    ).rejects.toThrow(/at least two legs/);
  });

  it('rejects a non-positive leg amount', async () => {
    await expect(
      postLedger(
        'bad',
        [
          { accountId: 'merchant', direction: 'credit', amountMinor: 0n, currency: 'USD' },
          { accountId: 'clearing', direction: 'debit', amountMinor: 0n, currency: 'USD' },
        ],
        db,
      ),
    ).rejects.toThrow(/must be positive/);
  });

  it('a reversal nets the original back to zero', async () => {
    // original money-in
    await postLedger(
      'txn1',
      [
        { accountId: 'merchant', direction: 'credit', amountMinor: 5000n, currency: 'USD' },
        { accountId: 'clearing', direction: 'debit', amountMinor: 5000n, currency: 'USD' },
      ],
      db,
    );
    // reversal: opposite directions, same amount
    await postLedger(
      'rev1',
      [
        { accountId: 'merchant', direction: 'debit', amountMinor: 5000n, currency: 'USD' },
        { accountId: 'clearing', direction: 'credit', amountMinor: 5000n, currency: 'USD' },
      ],
      db,
    );
    expect(db._accounts.get('merchant')!.balanceMinor).toBe(0n);
    // original entries still exist — nothing deleted
    expect(await ledgerBalance('merchant', db)).toBe(0n);
    const allMerchantEntries = await db.ledgerEntry.findMany({ where: { accountId: 'merchant' } });
    expect(allMerchantEntries.length).toBe(2);
  });
});
