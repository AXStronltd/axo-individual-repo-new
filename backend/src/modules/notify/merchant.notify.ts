import { prisma } from '../../db/client.js';
import { makeSender } from '../whatsapp/whatsapp.sender.js';
import { formatAmount } from '../whatsapp/chat.lib.js';

const sender = makeSender();

/**
 * Tell the business on WhatsApp that a payment arrived — the "you have received
 * KES 500 from…" message a till operator waits for.
 *
 * Best-effort and AFTER commit: the reliable channel is the transactional outbox
 * (signed webhooks) plus the dashboard / POS reading the payment request, and
 * this must never delay or fail the payment. It goes to the owner and managers
 * who have a phone on file. Only the payer's Axo tag is shown, never more of
 * their details.
 */
export async function notifyMerchantPaid(params: {
  merchantId: string;
  amountMinor: bigint;
  currency: string;
  customerId: string;
  requestId?: string;
}): Promise<void> {
  try {
    if (!sender.available) return;
    const [merchant, customer, staff, request] = await Promise.all([
      prisma.merchant.findUnique({ where: { id: params.merchantId } }),
      prisma.customer.findUnique({ where: { id: params.customerId } }),
      prisma.user.findMany({ where: { merchantId: params.merchantId, role: { in: ['owner', 'manager'] }, phone: { not: null } } }),
      params.requestId ? prisma.pushPrompt.findUnique({ where: { id: params.requestId } }) : null,
    ]);
    if (!merchant) return;
    const sale = request?.saleRef ? ` for sale ${request.saleRef}` : '';
    const body = `💰 ${merchant.tradingName}: received ${formatAmount(params.amountMinor, params.currency)} from ${customer?.axoTag ?? 'an Axo customer'}${sale}.`;
    for (const u of staff) {
      await sender.send({ to: u.phone!.replace(/^\+/, ''), body });
    }
  } catch {
    // notification is best-effort; never let it affect the payment
  }
}
