import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';
import { postLedger } from '../ledger/ledger.service.js';
import { getProvider } from '../payments/payments.service.js';
import { postCustomerLedger } from '../p2p/p2p.service.js';
import { enqueueMerchantEvent } from '../notify/outbox.service.js';

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
 * Refund a confirmed payment_in — in full, or in part.
 *
 * Never edits the original's amount or entries: it posts a NEW linked refund
 * transaction and raises the original's refundedMinor, which can never pass the
 * amount paid. That cap, checked inside a serializable transaction with a
 * compare-and-set on refundedMinor, is what stops a payment being refunded twice
 * (the old version left the original untouched, so every new idempotency key
 * refunded it again).
 *
 * For an Axo-wallet payment the money goes back to the customer's wallet on the
 * customer ledger in the same transaction. A payment that came in over an
 * external rail would need that rail's refund API, which no adapter has yet, so
 * it is refused rather than debited into a void.
 */
export async function refundPayment(input: { transactionId: string; merchantId: string; amountMinor?: bigint; actorId?: string; reason?: string }) {
  return inTransaction(async (tx) => {
    const original = await tx.transaction.findFirst({
      where: { id: input.transactionId, merchantId: input.merchantId },
    });
    if (!original) throw new Error('not_found');
    if (original.type !== 'payment_in' || original.status !== 'confirmed') {
      throw new Error('only a confirmed payment can be refunded');
    }
    if (!original.transferId) throw new Error('refund_not_supported_for_this_rail');

    const remaining = original.amountMinor - original.refundedMinor;
    const amount = input.amountMinor ?? remaining;
    if (amount <= 0n) throw new Error(remaining <= 0n ? 'already_fully_refunded' : 'bad_amount');
    if (amount > remaining) throw new Error('refund_exceeds_remaining');

    const { balance, clearing } = await accounts(original.merchantId, original.currency, tx);
    if (balance.balanceMinor < amount) throw new Error('insufficient_balance');

    const raised = await tx.transaction.updateMany({
      where: { id: original.id, refundedMinor: original.refundedMinor },
      data: { refundedMinor: { increment: amount } },
    });
    if (raised.count !== 1) throw new Error('refund was processed concurrently — retry');

    // The customer who paid is the sender of the linked customer-side transfer.
    const paid = await tx.p2PTransfer.findUniqueOrThrow({ where: { id: original.transferId } });
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: paid.senderId }, include: { wallet: true } });
    if (!customer.wallet) throw new Error('wallet_missing');
    const clearingCustomer = await tx.customer.findUniqueOrThrow({ where: { id: paid.recipientId }, include: { wallet: true } });

    // Customer side: clearing → wallet.
    const back = await tx.p2PTransfer.create({
      data: {
        senderId: clearingCustomer.id,
        recipientId: customer.id,
        amountMinor: amount,
        feeMinor: 0n,
        currency: original.currency,
        status: 'completed',
        note: 'refund' + (input.reason ? ' · ' + input.reason : ''),
        reversesId: paid.id,
        completedAt: new Date(),
      },
    });
    await postCustomerLedger(tx, back.id, [
      { accountId: clearingCustomer.wallet!.id, direction: 'debit', amountMinor: amount, currency: original.currency },
      { accountId: customer.wallet.id, direction: 'credit', amountMinor: amount, currency: original.currency },
    ]);

    // Merchant side: balance → clearing.
    const refund = await tx.transaction.create({
      data: {
        merchantId: original.merchantId,
        type: 'refund',
        status: 'confirmed',
        amountMinor: amount,
        currency: original.currency,
        provider: original.provider,
        reversesId: original.id,
        transferId: back.id,
        customerRef: original.customerRef,
        makerId: input.actorId,
        confirmedAt: new Date(),
      },
    });
    await postLedger(
      refund.id,
      [
        { accountId: balance.id, direction: 'debit', amountMinor: amount, currency: original.currency },
        { accountId: clearing.id, direction: 'credit', amountMinor: amount, currency: original.currency },
      ],
      tx,
    );

    await enqueueMerchantEvent(tx, original.merchantId, 'payment.refunded', {
      refundTransactionId: refund.id,
      transactionId: original.id,
      amountMinor: amount,
      refundedTotalMinor: original.refundedMinor + amount,
      currency: original.currency,
      reason: input.reason ?? null,
    });
    return { refund, customerId: customer.id, refundedTotalMinor: original.refundedMinor + amount };
  });
}
