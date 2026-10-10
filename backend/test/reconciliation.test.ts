import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/modules/reconciliation/reconciliation.service.js';

describe('reconciliation matcher', () => {
  it('matches equal expected and actual on providerRef', () => {
    const r = reconcile(
      [{ providerRef: 'A', amountMinor: 5000n }],
      [{ providerRef: 'A', actualMinor: 5000n, feeMinor: 100n }],
    );
    expect(r.rows[0]!.status).toBe('matched');
    expect(r.exceptions).toBe(0);
  });

  it('flags unmatched when the provider has not settled', () => {
    const r = reconcile(
      [{ providerRef: 'A', amountMinor: 5000n }],
      [],
    );
    expect(r.rows[0]!.status).toBe('unmatched');
    expect(r.exceptions).toBe(1);
  });

  it('flags a mismatch when amounts differ', () => {
    const r = reconcile(
      [{ providerRef: 'A', amountMinor: 5000n }],
      [{ providerRef: 'A', actualMinor: 4960n, feeMinor: 40n }],
    );
    expect(r.rows[0]!.status).toBe('mismatch');
    expect(r.exceptions).toBe(1);
  });

  it('flags unexpected when the provider settled something not in our ledger', () => {
    const r = reconcile(
      [],
      [{ providerRef: 'X', actualMinor: 6000n, feeMinor: 30n }],
    );
    expect(r.rows[0]!.status).toBe('unexpected');
    expect(r.exceptions).toBe(1);
  });

  it('computes fee and net totals', () => {
    const r = reconcile(
      [
        { providerRef: 'A', amountMinor: 5000n },
        { providerRef: 'B', amountMinor: 3000n },
      ],
      [
        { providerRef: 'A', actualMinor: 5000n, feeMinor: 100n },
        { providerRef: 'B', actualMinor: 3000n, feeMinor: 60n },
      ],
    );
    expect(r.expectedTotalMinor).toBe(8000n);
    expect(r.actualTotalMinor).toBe(8000n);
    expect(r.feeTotalMinor).toBe(160n);
    expect(r.netMinor).toBe(7840n); // actual - fees
    expect(r.exceptions).toBe(0);
  });

  it('handles a mixed batch: matched + unmatched + mismatch + unexpected', () => {
    const r = reconcile(
      [
        { providerRef: 'A', amountMinor: 5000n }, // matched
        { providerRef: 'B', amountMinor: 3000n }, // unmatched
        { providerRef: 'C', amountMinor: 2000n }, // mismatch
      ],
      [
        { providerRef: 'A', actualMinor: 5000n, feeMinor: 100n },
        { providerRef: 'C', actualMinor: 1980n, feeMinor: 20n },
        { providerRef: 'D', actualMinor: 999n, feeMinor: 1n }, // unexpected
      ],
    );
    const byRef = Object.fromEntries(r.rows.map((x) => [x.providerRef, x.status]));
    expect(byRef['A']).toBe('matched');
    expect(byRef['B']).toBe('unmatched');
    expect(byRef['C']).toBe('mismatch');
    expect(byRef['D']).toBe('unexpected');
    expect(r.exceptions).toBe(3);
  });
});
