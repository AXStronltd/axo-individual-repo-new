import { inTransaction } from '../../db/client.js';
import { postCustomerLedger } from './p2p.service.js';

const REVERSAL_WINDOW_MS = 10 * 60 * 1000; // a completed P2P can be recalled for 10 min

/**
 * Reverse a COMPLETED Axo-to-Axo transfer (M-Pesa "reverse — you paid the wrong
 * number"). Never edits the original: it posts a NEW compensating transfer
 * (recipient → sender) and marks the original reversed. Only within the window,
 * and only if the recipient still has the funds (you can't claw back money
 * already spent). For an UNCLAIMED send-to-unregistered, use refundClaimable
 * instead — there's nothing to reverse, just un-reserve.
 */
export async function reverseTransfer(params: { transferId: string; byCustomerId: string }) {
  return inTransaction(async (tx) => {
    const orig = await tx.p2PTransfer.findUniqueOrThrow({ where: { id: params.transferId } });
    if (orig.status === 'reversed') return { status: 'already_reversed' as const };
    if (orig.status !== 'completed') throw new Error('only a completed transfer can be reversed');
    if (orig.senderId !== params.byCustomerId) throw new Error('only the sender can recall a payment');
    if (Date.now() - orig.createdAt.getTime() > REVERSAL_WINDOW_MS) throw new Error('reversal window has passed');

    const sender = await tx.customer.findUniqueOrThrow({ where: { id: orig.senderId }, include: { wallet: true } });
    const recipient = await tx.customer.findUniqueOrThrow({ where: { id: orig.recipientId }, include: { wallet: true } });
    if (!sender.wallet || !recipient.wallet) throw new Error('wallet_missing');

    const recipSpendable = recipient.wallet.balanceMinor - recipient.wallet.reservedMinor;
    if (orig.amountMinor > recipSpendable) throw new Error('recipient has already spent the funds — cannot reverse automatically');

    // New compensating transfer: recipient → sender.
    const rev = await tx.p2PTransfer.create({
      data: {
        senderId: recipient.id,
        recipientId: sender.id,
        amountMinor: orig.amountMinor,
        feeMinor: 0n,
        currency: orig.currency,
        status: 'completed',
        note: 'reversal of ' + orig.id,
        reversesId: orig.id,
        completedAt: new Date(),
      },
    });
    await postCustomerLedger(tx, rev.id, [
      { accountId: recipient.wallet.id, direction: 'debit', amountMinor: orig.amountMinor, currency: orig.currency },
      { accountId: sender.wallet.id, direction: 'credit', amountMinor: orig.amountMinor, currency: orig.currency },
    ]);
    await tx.p2PTransfer.update({ where: { id: orig.id }, data: { status: 'reversed' } });
    return { status: 'reversed' as const, reversalId: rev.id };
  });
}
