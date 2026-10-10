import { prisma } from '../../db/client.js';
import { makeSender } from './whatsapp.sender.js';
import { formatAmount } from './chat.lib.js';

const sender = makeSender();

/**
 * Notify a customer on WhatsApp that money arrived. This is what makes the
 * individual side SYMMETRIC with person-to-person: whether a person, a business
 * payout, a refund, or a cash-in credited them, they get the same clear
 * "You received X from Y" message. Safe to call for any credit; silently does
 * nothing if the customer has no verified WhatsApp link or the sender is
 * unconfigured, so it never blocks the money movement.
 */
export async function notifyCredit(params: {
  customerId: string;
  amountMinor: bigint;
  currency: string;
  from: string;            // display name of the payer (business or @tag)
  kind?: 'payment' | 'refund' | 'payout' | 'cash_in';
}): Promise<void> {
  try {
    if (!sender.available) return;
    const link = await prisma.whatsAppLink.findUnique({ where: { customerId: params.customerId } });
    if (!link?.waId) return;
    const amt = formatAmount(params.amountMinor, params.currency);
    const verb: Record<string, string> = {
      payment: `💰 You received ${amt} from ${params.from}.`,
      refund: `↩️ ${params.from} refunded you ${amt}.`,
      payout: `💸 ${params.from} paid you ${amt}.`,
      cash_in: `✅ ${amt} added to your Axo wallet.`,
    };
    const body = (verb[params.kind ?? 'payment']) + '\nReply BALANCE to see your wallet.';
    await sender.send({ to: link.waId, body });
  } catch {
    // notification is best-effort; never let it affect the ledger
  }
}
