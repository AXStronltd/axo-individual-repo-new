// Pure helpers for mini-statement formatting and fee preview — testable without a DB.
import { formatMinor } from '../../lib/money.js';

export interface MiniRow {
  direction: 'in' | 'out';
  amountMinor: bigint;
  status: string;
  note?: string | null;
}

/** Format a short "last N" mini-statement like M-Pesa's SMS. */
export function formatMiniStatement(rows: MiniRow[], currency: string, decimals = 0): string {
  if (!rows.length) return 'No transactions yet.';
  const lines = rows.map((r) => `${r.direction === 'out' ? '−' : '+'} ${currency} ${formatMinor(r.amountMinor, decimals)}${r.note ? ' · ' + r.note : ''} · ${r.status}`);
  return '🧾 Mini-statement (last ' + rows.length + '):\n' + lines.join('\n');
}

/**
 * Preview the fee for a movement BEFORE the customer confirms (M-Pesa shows the
 * cost up front). Axo-to-Axo and pay-business are free; cash-out/global carry a
 * disclosed flat-bps fee. Returns the fee and the total that leaves the sender.
 */
export function previewFee(params: {
  kind: 'p2p' | 'pay_business' | 'cash_out' | 'global';
  amountMinor: bigint;
  feeBps?: number; // override; defaults per kind
}): { feeMinor: bigint; totalMinor: bigint; disclosed: string; currency?: string } {
  const defaults: Record<string, number> = { p2p: 0, pay_business: 0, cash_out: 100, global: 100 };
  const bps = params.feeBps ?? defaults[params.kind] ?? 0;
  const feeMinor = (params.amountMinor * BigInt(bps)) / 10_000n;
  const totalMinor = params.amountMinor + feeMinor;
  const disclosed = bps === 0 ? 'No fee — free on Axo.' : `Fee: ${(bps / 100).toFixed(2)}% (shown before you confirm).`;
  return { feeMinor, totalMinor, disclosed };
}
