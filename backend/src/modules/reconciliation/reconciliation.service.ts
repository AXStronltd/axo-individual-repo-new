import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';
import { postLedger } from '../ledger/ledger.service.js';

export type ReconStatus = 'matched' | 'unmatched' | 'mismatch' | 'unexpected';

export interface ExpectedTxn {
  providerRef: string;
  amountMinor: bigint;
}

export interface ProviderRecord {
  providerRef: string;
  actualMinor: bigint;
  feeMinor: bigint;
}

export interface ReconRow {
  providerRef: string;
  expectedMinor: bigint | null;
  actualMinor: bigint | null;
  feeMinor: bigint | null;
  status: ReconStatus;
}

export interface ReconResult {
  rows: ReconRow[];
  expectedTotalMinor: bigint;
  actualTotalMinor: bigint;
  feeTotalMinor: bigint;
  netMinor: bigint; // actual - fees
  exceptions: number;
}

/**
 * Pure matcher: compare what we expected (our confirmed transactions) against
 * what the provider actually settled, keyed on providerRef. No DB, fully testable.
 */
export function reconcile(expected: ExpectedTxn[], provider: ProviderRecord[]): ReconResult {
  const exp = new Map(expected.map((e) => [e.providerRef, e]));
  const prov = new Map(provider.map((p) => [p.providerRef, p]));
  const rows: ReconRow[] = [];

  for (const [ref, e] of exp) {
    const p = prov.get(ref);
    if (!p) {
      rows.push({ providerRef: ref, expectedMinor: e.amountMinor, actualMinor: null, feeMinor: null, status: 'unmatched' });
    } else if (p.actualMinor !== e.amountMinor) {
      rows.push({ providerRef: ref, expectedMinor: e.amountMinor, actualMinor: p.actualMinor, feeMinor: p.feeMinor, status: 'mismatch' });
    } else {
      rows.push({ providerRef: ref, expectedMinor: e.amountMinor, actualMinor: p.actualMinor, feeMinor: p.feeMinor, status: 'matched' });
    }
  }
  for (const [ref, p] of prov) {
    if (!exp.has(ref)) {
      rows.push({ providerRef: ref, expectedMinor: null, actualMinor: p.actualMinor, feeMinor: p.feeMinor, status: 'unexpected' });
    }
  }

  let expectedTotal = 0n;
  let actualTotal = 0n;
  let feeTotal = 0n;
  for (const r of rows) {
    if (r.expectedMinor) expectedTotal += r.expectedMinor;
    if (r.actualMinor) actualTotal += r.actualMinor;
    if (r.feeMinor) feeTotal += r.feeMinor;
  }
  const exceptions = rows.filter((r) => r.status !== 'matched').length;

  return {
    rows,
    expectedTotalMinor: expectedTotal,
    actualTotalMinor: actualTotal,
    feeTotalMinor: feeTotal,
    netMinor: actualTotal - feeTotal,
    exceptions,
  };
}

/** Import provider settlement records, then run reconciliation for a merchant. */
export async function importAndReconcile(merchantId: string, records: ProviderRecord[] & { currency?: string }[]) {
  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });

  // Store/refresh settlement rows (idempotent on provider+providerRef).
  for (const rec of records) {
    await prisma.settlement.upsert({
      where: { provider_providerRef: { provider: 'sandbox', providerRef: rec.providerRef } },
      update: { actualMinor: rec.actualMinor, feeMinor: rec.feeMinor },
      create: {
        merchantId,
        provider: 'sandbox',
        providerRef: rec.providerRef,
        actualMinor: rec.actualMinor,
        feeMinor: rec.feeMinor,
        currency: merchant.currency,
      },
    });
  }

  const confirmed = await prisma.transaction.findMany({
    where: { merchantId, status: 'confirmed', type: 'payment_in', providerRef: { not: null } },
  });
  const expected: ExpectedTxn[] = confirmed.map((t: (typeof confirmed)[number]) => ({ providerRef: t.providerRef!, amountMinor: t.amountMinor }));

  const result = reconcile(expected, records);

  // Persist the status onto settlement rows + link matched transactions.
  for (const row of result.rows) {
    const match = confirmed.find((t: (typeof confirmed)[number]) => t.providerRef === row.providerRef);
    await prisma.settlement.updateMany({
      where: { provider: 'sandbox', providerRef: row.providerRef },
      data: { reconStatus: row.status, matchedTxnId: match?.id ?? null },
    });
  }
  return result;
}

/**
 * Resolve a mismatch by posting an adjustment entry for the difference, never by
 * editing the original transaction. Marks the settlement row matched.
 */
export async function resolveMismatch(input: { settlementId: string; merchantId: string }) {
  return inTransaction(async (tx) => {
    const s = await tx.settlement.findFirstOrThrow({
      where: { id: input.settlementId, merchantId: input.merchantId },
    });
    if (s.reconStatus !== 'mismatch') throw new Error('only a mismatch can be adjusted');
    if (!s.matchedTxnId) throw new Error('no linked transaction to adjust against');

    const original = await tx.transaction.findUniqueOrThrow({ where: { id: s.matchedTxnId } });
    const diff: bigint = BigInt(s.actualMinor) - BigInt(original.amountMinor); // + if provider paid more

    const balance = await tx.account.upsert({
      where: { merchantId_type_currency: { merchantId: s.merchantId, type: 'axo_balance', currency: s.currency } },
      update: {},
      create: { merchantId: s.merchantId, type: 'axo_balance', currency: s.currency },
    });
    const clearing = await tx.account.upsert({
      where: { merchantId_type_currency: { merchantId: s.merchantId, type: 'clearing', currency: s.currency } },
      update: {},
      create: { merchantId: s.merchantId, type: 'clearing', currency: s.currency },
    });

    const adj = await tx.transaction.create({
      data: {
        merchantId: s.merchantId,
        type: diff >= 0n ? 'payment_in' : 'reversal',
        status: 'confirmed',
        amountMinor: diff < 0n ? -diff : diff,
        currency: s.currency,
        provider: 'sandbox',
        reversesId: original.id,
        confirmedAt: new Date(),
      },
    });
    const amt: bigint = diff < 0n ? -diff : diff;
    if (amt > 0n) {
      const legs =
        diff > 0n
          ? [
              { accountId: balance.id, direction: 'credit' as const, amountMinor: amt, currency: s.currency },
              { accountId: clearing.id, direction: 'debit' as const, amountMinor: amt, currency: s.currency },
            ]
          : [
              { accountId: balance.id, direction: 'debit' as const, amountMinor: amt, currency: s.currency },
              { accountId: clearing.id, direction: 'credit' as const, amountMinor: amt, currency: s.currency },
            ];
      await postLedger(adj.id, legs, tx);
    }

    await tx.settlement.update({
      where: { id: s.id },
      data: { reconStatus: 'matched', resolvedAt: new Date() },
    });
    return { adjustment: adj, differenceMinor: diff };
  });
}
