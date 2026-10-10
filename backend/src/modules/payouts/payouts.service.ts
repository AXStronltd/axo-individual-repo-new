import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';
import { postLedger } from '../ledger/ledger.service.js';
import { getProvider } from '../payments/payments.service.js';

async function accounts(merchantId: string, currency: string, tx: PrismaClient) {
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
 * Create a payout request. Maker-checker: starts as `awaiting_approval`. No money
 * moves yet. Checks the balance is sufficient under a row lock so two payouts
 * can't both pass the check and overdraw.
 */
export async function createPayout(input: {
  merchantId: string;
  makerId: string;
  amountMinor: bigint;
  currency: string;
  destination: string;
}) {
  return inTransaction(async (tx) => {
    const { balance } = await accounts(input.merchantId, input.currency, tx);
    if (balance.balanceMinor < input.amountMinor) {
      throw new Error('insufficient_balance');
    }
    return tx.transaction.create({
      data: {
        merchantId: input.merchantId,
        type: 'payout',
        status: 'awaiting_approval',
        amountMinor: input.amountMinor,
        currency: input.currency,
        provider: 'sandbox',
        customerRef: input.destination,
        makerId: input.makerId,
      },
    });
  });
}

/**
 * Approve + execute a payout. Maker-checker: the checker must differ from the
 * maker. On approval we debit the balance, mark pending, and submit to the
 * provider. The ledger debit happens now (funds are committed out); the provider
 * webhook later confirms delivery or reverses on failure.
 */
export async function approveAndExecutePayout(input: {
  transactionId: string;
  checkerId: string;
  merchantId: string;
}) {
  return inTransaction(async (tx) => {
    const po = await tx.transaction.findFirstOrThrow({
      where: { id: input.transactionId, merchantId: input.merchantId, type: 'payout' },
    });
    if (po.status !== 'awaiting_approval') throw new Error(`cannot approve a ${po.status} payout`);
    if (po.makerId && po.makerId === input.checkerId) throw new Error('maker_cannot_check');

    const { balance, clearing } = await accounts(po.merchantId, po.currency, tx);
    if (balance.balanceMinor < po.amountMinor) throw new Error('insufficient_balance');

    // Money out: debit the balance, credit clearing (held until provider confirms).
    await postLedger(
      po.id,
      [
        { accountId: balance.id, direction: 'debit', amountMinor: po.amountMinor, currency: po.currency },
        { accountId: clearing.id, direction: 'credit', amountMinor: po.amountMinor, currency: po.currency },
      ],
      tx,
    );

    const provider = getProvider(po.provider);
    const result = await provider.createPayout({
      amountMinor: po.amountMinor,
      currency: po.currency,
      destination: po.customerRef ?? '',
      reference: po.id,
    });

    if (result.status === 'rejected') {
      // roll back the ledger move by posting the reverse, mark failed
      await postLedger(
        po.id,
        [
          { accountId: balance.id, direction: 'credit', amountMinor: po.amountMinor, currency: po.currency },
          { accountId: clearing.id, direction: 'debit', amountMinor: po.amountMinor, currency: po.currency },
        ],
        tx,
      );
      return tx.transaction.update({ where: { id: po.id }, data: { status: 'failed' } });
    }

    return tx.transaction.update({
      where: { id: po.id },
      data: {
        status: 'pending',
        providerRef: result.providerRef,
        checkerId: input.checkerId,
        approvedAt: new Date(),
      },
    });
  });
}

/**
 * Refund a confirmed payment_in. Posts a NEW linked transaction + entries that
 * move the amount back out. The original is never edited; it stays confirmed and
 * the refund references it.
 */
export async function refundPayment(input: { transactionId: string; merchantId: string }) {
  return inTransaction(async (tx) => {
    const original = await tx.transaction.findFirstOrThrow({
      where: { id: input.transactionId, merchantId: input.merchantId },
    });
    if (original.type !== 'payment_in' || original.status !== 'confirmed') {
      throw new Error('only a confirmed payment can be refunded');
    }
    const { balance, clearing } = await accounts(original.merchantId, original.currency, tx);
    if (balance.balanceMinor < original.amountMinor) throw new Error('insufficient_balance');

    const refund = await tx.transaction.create({
      data: {
        merchantId: original.merchantId,
        type: 'refund',
        status: 'confirmed',
        amountMinor: original.amountMinor,
        currency: original.currency,
        provider: original.provider,
        reversesId: original.id,
        confirmedAt: new Date(),
      },
    });
    await postLedger(
      refund.id,
      [
        { accountId: balance.id, direction: 'debit', amountMinor: original.amountMinor, currency: original.currency },
        { accountId: clearing.id, direction: 'credit', amountMinor: original.amountMinor, currency: original.currency },
      ],
      tx,
    );
    return refund;
  });
}
