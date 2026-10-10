import { prisma, inTransaction } from '../../db/client.js';
import { postLedger } from '../ledger/ledger.service.js';
import { getProvider } from '../payments/payments.service.js';
import type { Recipient } from './batch.lib.js';
import { batchTotalMinor } from './batch.lib.js';

/** Create a batch in draft from validated recipients. No money moves. */
export async function createBatch(input: {
  merchantId: string;
  makerId: string;
  kind: string;
  currency: string;
  recipients: Recipient[];
}) {
  return prisma.batch.create({
    data: {
      merchantId: input.merchantId,
      kind: input.kind,
      currency: input.currency,
      makerId: input.makerId,
      items: {
        create: input.recipients.map((r) => ({
          recipient: r.recipient,
          destination: r.destination,
          amountMinor: r.amountMinor,
        })),
      },
    },
    include: { items: true },
  });
}

export async function previewBatch(batchId: string, merchantId: string) {
  const batch = await prisma.batch.findFirstOrThrow({
    where: { id: batchId, merchantId },
    include: { items: true },
  });
  const recipients: Recipient[] = batch.items.map((i: (typeof batch.items)[number]) => ({
    recipient: i.recipient,
    destination: i.destination,
    amountMinor: i.amountMinor,
  }));
  return { batch, count: batch.items.length, totalMinor: batchTotalMinor(recipients) };
}

/**
 * Approve a batch. Maker-checker: checker must differ from maker. Verifies the
 * balance covers the whole batch before approving.
 */
export async function approveBatch(input: { batchId: string; checkerId: string; merchantId: string }) {
  return inTransaction(async (tx) => {
    const batch = await tx.batch.findFirstOrThrow({
      where: { id: input.batchId, merchantId: input.merchantId },
      include: { items: true },
    });
    if (batch.status !== 'draft') throw new Error(`cannot approve a ${batch.status} batch`);
    if (batch.makerId && batch.makerId === input.checkerId) throw new Error('maker_cannot_check');

    const total = batch.items.reduce((s: bigint, i: (typeof batch.items)[number]) => s + i.amountMinor, 0n);
    const balance = await tx.account.upsert({
      where: { merchantId_type_currency: { merchantId: batch.merchantId, type: 'axo_balance', currency: batch.currency } },
      update: {},
      create: { merchantId: batch.merchantId, type: 'axo_balance', currency: batch.currency },
    });
    if (balance.balanceMinor < total) throw new Error('insufficient_balance');

    return tx.batch.update({
      where: { id: batch.id },
      data: { status: 'approved', checkerId: input.checkerId, approvedAt: new Date() },
    });
  });
}

/**
 * Execute an approved batch. Each item is paid once: an item already `paid` is
 * skipped, so a retry after a partial failure never double-pays. Each item's
 * payout debits the balance and posts the ledger inside its own transaction.
 */
export async function executeBatch(input: { batchId: string; merchantId: string }) {
  const batch = await prisma.batch.findFirstOrThrow({
    where: { id: input.batchId, merchantId: input.merchantId },
    include: { items: true },
  });
  if (batch.status !== 'approved' && batch.status !== 'executing' && batch.status !== 'completed') {
    throw new Error('batch is not approved');
  }
  await prisma.batch.update({ where: { id: batch.id }, data: { status: 'executing' } });

  for (const item of batch.items) {
    if (item.status === 'paid') continue; // retry-safe: never pay twice

    try {
      await inTransaction(async (tx) => {
        // re-read the item inside the tx to avoid a race on retry
        const fresh = await tx.batchItem.findUniqueOrThrow({ where: { id: item.id } });
        if (fresh.status === 'paid') return;

        const balance = await tx.account.upsert({
          where: { merchantId_type_currency: { merchantId: batch.merchantId, type: 'axo_balance', currency: batch.currency } },
          update: {},
          create: { merchantId: batch.merchantId, type: 'axo_balance', currency: batch.currency },
        });
        const clearing = await tx.account.upsert({
          where: { merchantId_type_currency: { merchantId: batch.merchantId, type: 'clearing', currency: batch.currency } },
          update: {},
          create: { merchantId: batch.merchantId, type: 'clearing', currency: batch.currency },
        });
        if (balance.balanceMinor < fresh.amountMinor) throw new Error('insufficient_balance');

        const txn = await tx.transaction.create({
          data: {
            merchantId: batch.merchantId,
            type: 'payout',
            status: 'pending',
            amountMinor: fresh.amountMinor,
            currency: batch.currency,
            provider: 'sandbox',
            customerRef: fresh.destination,
          },
        });
        await postLedger(
          txn.id,
          [
            { accountId: balance.id, direction: 'debit', amountMinor: fresh.amountMinor, currency: batch.currency },
            { accountId: clearing.id, direction: 'credit', amountMinor: fresh.amountMinor, currency: batch.currency },
          ],
          tx,
        );
        const result = await getProvider('sandbox').createPayout({
          amountMinor: fresh.amountMinor,
          currency: batch.currency,
          destination: fresh.destination,
          reference: txn.id,
        });
        if (result.status === 'rejected') throw new Error('provider_rejected');

        await tx.transaction.update({ where: { id: txn.id }, data: { providerRef: result.providerRef } });
        await tx.batchItem.update({
          where: { id: fresh.id },
          data: { status: 'paid', transactionId: txn.id, error: null },
        });
      });
    } catch (e) {
      await prisma.batchItem.update({
        where: { id: item.id },
        data: { status: 'failed', error: (e as Error).message },
      });
    }
  }

  const items = await prisma.batchItem.findMany({ where: { batchId: batch.id } });
  const anyFailed = items.some((i: (typeof items)[number]) => i.status === 'failed');
  const status = anyFailed ? 'completed' : 'completed'; // completed either way; failures are per-item
  await prisma.batch.update({ where: { id: batch.id }, data: { status } });

  return {
    batchId: batch.id,
    paid: items.filter((i: (typeof items)[number]) => i.status === 'paid').length,
    failed: items.filter((i: (typeof items)[number]) => i.status === 'failed').length,
    items,
  };
}
