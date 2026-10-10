import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';
import { postLedger } from '../ledger/ledger.service.js';
import { sandboxProvider } from '../../providers/sandbox.js';
import type { PaymentProvider } from '../../providers/types.js';
import { isLive } from '../../config/env.js';

// Live adapters register here by name. The sandbox provider signs its webhooks
// with a secret that exists only for development, so it is never registered in
// live — otherwise anyone holding that secret could confirm a charge that no
// money ever backed. Axo-to-Axo payments don't go through this table at all:
// they settle on Axo's own ledger in p2p.service (payMerchant).
const providers: Record<string, PaymentProvider> = isLive ? {} : { sandbox: sandboxProvider };

export function findProvider(name: string): PaymentProvider | undefined {
  return Object.prototype.hasOwnProperty.call(providers, name) ? providers[name] : undefined;
}

export function getProvider(name: string): PaymentProvider {
  const p = findProvider(name);
  if (!p) throw new Error(`unknown provider: ${name}`);
  return p;
}

/** Ensure the merchant's balance and clearing accounts exist for a currency. */
async function ensureAccounts(merchantId: string, currency: string, tx: PrismaClient) {
  const balance = await tx.account.upsert({
    where: { merchantId_type_currency: { merchantId, type: 'axo_balance', currency } },
    update: {},
    create: { merchantId, type: 'axo_balance', currency },
  });
  const clearing = await tx.account.upsert({
    where: { merchantId_type_currency: { merchantId, type: 'clearing', currency } },
    update: {},
    create: { merchantId, type: 'clearing', currency },
  });
  return { balance, clearing };
}

/**
 * Create a charge. The transaction starts as PENDING and no spendable money is
 * credited yet. Confirmation only happens when a verified webhook arrives.
 */
export async function createCharge(input: {
  merchantId: string;
  amountMinor: bigint;
  currency: string;
  customerRef: string;
  provider?: string;
}) {
  const providerName = input.provider ?? 'sandbox';
  const provider = getProvider(providerName);

  const txn = await prisma.transaction.create({
    data: {
      merchantId: input.merchantId,
      type: 'payment_in',
      status: 'pending',
      amountMinor: input.amountMinor,
      currency: input.currency,
      provider: providerName,
      customerRef: input.customerRef,
    },
  });

  const result = await provider.createCharge({
    amountMinor: input.amountMinor,
    currency: input.currency,
    customerRef: input.customerRef,
    reference: txn.id,
  });

  if (result.status === 'rejected') {
    await prisma.transaction.update({ where: { id: txn.id }, data: { status: 'failed' } });
    return { ...txn, status: 'failed' as const };
  }

  const updated = await prisma.transaction.update({
    where: { id: txn.id },
    data: { providerRef: result.providerRef },
  });
  return updated; // still pending
}

/**
 * Confirm a charge from a verified webhook. Idempotent on the webhook event id
 * and on transaction status: a second confirm for an already-confirmed txn is a
 * no-op. Posts the ledger entries that credit the merchant's spendable balance.
 */
export async function confirmChargeFromWebhook(args: {
  eventId: string;
  provider: string;
  providerRef: string;
  outcome: 'confirmed' | 'failed';
}): Promise<{ applied: boolean; reason?: string }> {
  return inTransaction(async (tx) => {
    // De-dupe the webhook event itself.
    const seen = await tx.webhookEvent.findUnique({ where: { id: args.eventId } });
    if (seen) return { applied: false, reason: 'duplicate_event' };
    await tx.webhookEvent.create({ data: { id: args.eventId, provider: args.provider } });

    const txn = await tx.transaction.findFirst({
      where: { provider: args.provider, providerRef: args.providerRef },
    });
    if (!txn) return { applied: false, reason: 'unknown_transaction' };
    if (txn.status !== 'pending') return { applied: false, reason: `already_${txn.status}` };

    if (args.outcome === 'failed') {
      await tx.transaction.update({ where: { id: txn.id }, data: { status: 'failed' } });
      return { applied: true };
    }

    const { balance, clearing } = await ensureAccounts(txn.merchantId, txn.currency, tx);
    // Money in: credit the merchant balance, debit the clearing account.
    await postLedger(
      txn.id,
      [
        { accountId: balance.id, direction: 'credit', amountMinor: txn.amountMinor, currency: txn.currency },
        { accountId: clearing.id, direction: 'debit', amountMinor: txn.amountMinor, currency: txn.currency },
      ],
      tx,
    );
    await tx.transaction.update({
      where: { id: txn.id },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
    return { applied: true };
  });
}

/**
 * Reverse a confirmed payment. Posts a new, linked set of entries — never edits
 * or deletes the original. The original transaction stays visible, marked reversed.
 */
export async function reverseTransaction(transactionId: string) {
  return inTransaction(async (tx) => {
    const original = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    if (original.status !== 'confirmed') throw new Error('only confirmed transactions can be reversed');

    const { balance, clearing } = await ensureAccounts(original.merchantId, original.currency, tx);

    const rev = await tx.transaction.create({
      data: {
        merchantId: original.merchantId,
        type: 'reversal',
        status: 'confirmed',
        amountMinor: original.amountMinor,
        currency: original.currency,
        provider: original.provider,
        reversesId: original.id,
        confirmedAt: new Date(),
      },
    });
    // Undo the original: debit the balance back out, credit clearing.
    await postLedger(
      rev.id,
      [
        { accountId: balance.id, direction: 'debit', amountMinor: original.amountMinor, currency: original.currency },
        { accountId: clearing.id, direction: 'credit', amountMinor: original.amountMinor, currency: original.currency },
      ],
      tx,
    );
    await tx.transaction.update({ where: { id: original.id }, data: { status: 'reversed' } });
    return rev;
  });
}
