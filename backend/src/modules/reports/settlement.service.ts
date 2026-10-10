import { prisma } from '../../db/client.js';

export interface SettlementException {
  transactionId: string;
  problem: 'missing_customer_leg' | 'amount_mismatch' | 'customer_leg_unbalanced' | 'customer_leg_not_completed' | 'merchant_leg_unbalanced';
}

/**
 * The business's daily settlement report, for one UTC day and currency.
 *
 * - gross: confirmed payments in; refunds: confirmed refunds out; fees: Axo
 *   charges none yet, reported explicitly as 0; net = gross − refunds − fees.
 * - Axo-wallet payments settle INSTANTLY into the business's Axo balance (the
 *   ledger posting is the settlement), so they are reported "settled_to_balance".
 *   Moving that balance to a bank is a payout, reported separately by status.
 * - Cross-ledger check: every Axo payment / refund in the window must have its
 *   customer-side transfer, for the same amount, completed, and both ledger
 *   postings must net to zero. Anything else is listed as an exception.
 */
export async function settlementReport(params: { merchantId: string; date: string; currency?: string }) {
  const from = new Date(params.date + 'T00:00:00.000Z');
  if (Number.isNaN(from.getTime())) throw new Error('invalid_date');
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: params.merchantId } });
  const currency = (params.currency ?? merchant.currency).toUpperCase();

  const txns = await prisma.transaction.findMany({
    where: { merchantId: merchant.id, currency, createdAt: { gte: from, lt: to } },
    orderBy: { createdAt: 'asc' },
  });

  const sum = (rows: typeof txns) => rows.reduce((s, t) => s + t.amountMinor, 0n);
  const payments = txns.filter((t) => t.type === 'payment_in' && t.status === 'confirmed');
  const refunds = txns.filter((t) => t.type === 'refund' && t.status === 'confirmed');
  const payouts = txns.filter((t) => t.type === 'payout');

  const gross = sum(payments);
  const refunded = sum(refunds);
  const fees = 0n;

  // Cross-ledger check on every Axo-wallet movement in the window.
  const exceptions: SettlementException[] = [];
  const linked = [...payments, ...refunds].filter((t) => t.provider === 'axo');
  for (const t of linked) {
    const merchantNet = await netOf(prisma.ledgerEntry.findMany({ where: { transactionId: t.id } }));
    if (merchantNet !== 0n) exceptions.push({ transactionId: t.id, problem: 'merchant_leg_unbalanced' });
    if (!t.transferId) {
      if (t.type === 'payment_in') exceptions.push({ transactionId: t.id, problem: 'missing_customer_leg' });
      continue;
    }
    const transfer = await prisma.p2PTransfer.findUnique({ where: { id: t.transferId } });
    if (!transfer) { exceptions.push({ transactionId: t.id, problem: 'missing_customer_leg' }); continue; }
    if (transfer.amountMinor !== t.amountMinor) exceptions.push({ transactionId: t.id, problem: 'amount_mismatch' });
    if (!['completed', 'reversed'].includes(transfer.status)) exceptions.push({ transactionId: t.id, problem: 'customer_leg_not_completed' });
    const customerNet = await netOf(prisma.customerLedgerEntry.findMany({ where: { transferId: transfer.id } }));
    if (customerNet !== 0n) exceptions.push({ transactionId: t.id, problem: 'customer_leg_unbalanced' });
  }

  const balance = await prisma.account.findFirst({ where: { merchantId: merchant.id, type: 'axo_balance', currency } });
  const payoutsByStatus: Record<string, { count: number; amountMinor: bigint }> = {};
  for (const p of payouts) {
    const b = (payoutsByStatus[p.status] ??= { count: 0, amountMinor: 0n });
    b.count++;
    b.amountMinor += p.amountMinor;
  }

  return {
    merchantId: merchant.id,
    date: params.date,
    timezone: 'UTC',
    currency,
    collections: {
      count: payments.length,
      grossMinor: gross,
      refundsCount: refunds.length,
      refundsMinor: refunded,
      feesMinor: fees,
      netMinor: gross - refunded - fees,
      settlementStatus: 'settled_to_balance' as const,
    },
    payouts: payoutsByStatus,
    closingBalanceMinor: balance?.balanceMinor ?? 0n,
    reconciliation: {
      checked: linked.length,
      exceptions,
      status: exceptions.length === 0 ? ('balanced' as const) : ('exceptions' as const),
    },
  };
}

async function netOf(rowsP: Promise<Array<{ direction: string; amountMinor: bigint }>>): Promise<bigint> {
  const rows = await rowsP;
  return rows.reduce((s, e) => s + (e.direction === 'credit' ? e.amountMinor : -e.amountMinor), 0n);
}
