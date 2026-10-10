import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';
import { postLedger } from '../ledger/ledger.service.js';

// invoice total = subtotal + tax, all in minor units.
export function invoiceTotalMinor(subtotalMinor: bigint, taxRate: number): bigint {
  // tax in basis points to stay integer: round(subtotal * rate%).
  const bps = BigInt(Math.round(taxRate * 100)); // 16% -> 1600
  const tax = (subtotalMinor * bps) / 10000n;
  return subtotalMinor + tax;
}

async function nextInvoiceNumber(merchantId: string, tx: PrismaClient): Promise<string> {
  const counter = await tx.counter.upsert({
    where: { merchantId_name: { merchantId, name: 'invoice' } },
    update: { value: { increment: 1 } },
    create: { merchantId, name: 'invoice', value: 1 },
  });
  return 'INV-' + String(counter.value).padStart(6, '0');
}

export async function createInvoice(input: {
  merchantId: string;
  customerName: string;
  customerPhone?: string;
  subtotalMinor: bigint;
  taxRate: number;
  dueDate?: Date;
  issue?: boolean; // issue immediately, else leave as draft
}) {
  return inTransaction(async (tx) => {
    const number = await nextInvoiceNumber(input.merchantId, tx);
    return tx.invoice.create({
      data: {
        merchantId: input.merchantId,
        number,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        subtotalMinor: input.subtotalMinor,
        taxRate: input.taxRate,
        dueDate: input.dueDate,
        status: input.issue ? 'issued' : 'draft',
        issuedAt: input.issue ? new Date() : null,
      },
    });
  });
}

export async function issueInvoice(invoiceId: string) {
  return prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: 'issued', issuedAt: new Date() },
  });
}

/** Amount still owed on an invoice. */
export async function amountDueMinor(invoiceId: string, tx: PrismaClient): Promise<bigint> {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const total = invoiceTotalMinor(inv.subtotalMinor, inv.taxRate);
  const paid = await tx.invoicePayment.aggregate({
    where: { invoiceId },
    _sum: { amountMinor: true },
  });
  const paidSum = paid._sum.amountMinor ?? 0n;
  return total - paidSum;
}

/**
 * Record a payment against an invoice. Creates a CONFIRMED payment_in
 * transaction (money recorded as received by this method), posts the ledger,
 * links an invoice_payment, and advances the invoice state. A partial amount
 * keeps the invoice open as partially_paid; overpayment is clamped to the balance.
 */
export async function recordInvoicePayment(input: {
  invoiceId: string;
  amountMinor: bigint;
  method: string; // axo / cash / bank
}) {
  return inTransaction(async (tx) => {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: input.invoiceId } });
    if (inv.status === 'cancelled') throw new Error('invoice is cancelled');

    const due = await amountDueMinor(input.invoiceId, tx);
    if (due <= 0n) throw new Error('invoice already settled');
    const amount = input.amountMinor > due ? due : input.amountMinor;
    if (amount <= 0n) throw new Error('amount must be positive');

    // Accounts are keyed by the merchant's own currency.
    const merchant = await tx.merchant.findUniqueOrThrow({ where: { id: inv.merchantId } });
    const currency = merchant.currency;
    const balanceAcc = await tx.account.upsert({
      where: { merchantId_type_currency: { merchantId: inv.merchantId, type: 'axo_balance', currency } },
      update: {},
      create: { merchantId: inv.merchantId, type: 'axo_balance', currency },
    });
    const clearing = await tx.account.upsert({
      where: { merchantId_type_currency: { merchantId: inv.merchantId, type: 'clearing', currency } },
      update: {},
      create: { merchantId: inv.merchantId, type: 'clearing', currency },
    });

    const txn = await tx.transaction.create({
      data: {
        merchantId: inv.merchantId,
        type: 'payment_in',
        status: 'confirmed',
        amountMinor: amount,
        currency,
        provider: 'axo',
        customerRef: inv.customerName,
        confirmedAt: new Date(),
      },
    });

    await postLedger(
      txn.id,
      [
        { accountId: balanceAcc.id, direction: 'credit', amountMinor: amount, currency },
        { accountId: clearing.id, direction: 'debit', amountMinor: amount, currency },
      ],
      tx,
    );

    await tx.invoicePayment.create({
      data: { invoiceId: inv.id, transactionId: txn.id, amountMinor: amount, method: input.method },
    });

    const remaining = due - amount;
    const newStatus = remaining <= 0n ? 'paid' : 'partially_paid';
    const updated = await tx.invoice.update({ where: { id: inv.id }, data: { status: newStatus } });

    return { invoice: updated, transaction: txn, appliedMinor: amount, remainingMinor: remaining };
  });
}

export async function cancelInvoice(invoiceId: string) {
  return prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'cancelled' } });
}

/** Derived overdue check (not stored): issued/partial + past due + balance owed. */
export function isOverdue(inv: { status: string; dueDate: Date | null }, now = new Date()): boolean {
  if (inv.status !== 'issued' && inv.status !== 'partially_paid') return false;
  return !!inv.dueDate && inv.dueDate < now;
}
