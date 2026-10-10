import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';
import { quoteTransfer, checkTransfer, normalizeWaId } from './p2p.lib.js';
import { postCustomerLedger } from './p2p.service.js';
import crypto from 'node:crypto';

const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days to claim, then auto-refund

function claimCode(): string {
  return 'CLM-' + crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Send money to a phone number with NO Axo wallet (M-Pesa "send to unregistered").
 * The sender's funds are RESERVED immediately (so they can't be double-spent),
 * and a claim code is issued. No recipient ledger movement happens until the
 * recipient claims. Idempotent on idempotencyKey.
 */
export async function sendToUnregistered(params: {
  senderId: string;
  recipientPhone: string;
  amountMinor: bigint;
  currency: string;
  note?: string;
  idempotencyKey?: string;
}) {
  const waId = normalizeWaId(params.recipientPhone);
  if (!waId) throw new Error('invalid recipient phone');

  return inTransaction(async (tx) => {
    if (params.idempotencyKey) {
      const existing = await tx.claimableTransfer.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
      if (existing) return existing;
    }
    // If the number actually IS an Axo user, this should have gone through sendP2P.
    const already = await tx.whatsAppLink.findUnique({ where: { waId } });
    if (already) throw new Error('recipient already has an Axo wallet — use a normal send');

    const sender = await tx.customer.findUniqueOrThrow({ where: { id: params.senderId }, include: { wallet: true } });
    if (!sender.wallet) throw new Error('wallet_missing');

    const quote = quoteTransfer(params.amountMinor);
    const spendable = sender.wallet.balanceMinor - sender.wallet.reservedMinor;
    const check = checkTransfer({
      senderStatus: sender.status,
      recipientStatus: 'active', // the eventual recipient; nothing to block yet
      senderId: sender.id,
      recipientId: 'unregistered:' + waId,
      currency: params.currency,
      senderCurrency: sender.wallet.currency,
      recipientCurrency: params.currency,
      spendableMinor: spendable,
      spentTodayMinor: 0n,
      tier: sender.kycTier as 'basic' | 'verified',
      quote,
    });
    if (!check.ok) throw new Error(check.reason);

    // Reserve on the sender (no balance change yet).
    await tx.customerAccount.update({ where: { id: sender.wallet.id }, data: { reservedMinor: { increment: quote.amountMinor } } });

    return tx.claimableTransfer.create({
      data: {
        code: claimCode(),
        senderId: sender.id,
        recipientWaId: waId,
        amountMinor: quote.amountMinor,
        currency: params.currency,
        note: params.note,
        status: 'unclaimed',
        idempotencyKey: params.idempotencyKey,
        expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
      },
    });
  });
}

/**
 * Claim a pending send: provision the recipient's wallet if needed, then move the
 * money — release the sender's reservation and post the real debit/credit to the
 * customer ledger. Idempotent: an already-claimed code returns without re-paying.
 */
export async function claimTransfer(params: { code: string; recipientWaId: string }) {
  const waId = normalizeWaId(params.recipientWaId);
  if (!waId) throw new Error('invalid phone');

  return inTransaction(async (tx) => {
    const ct = await tx.claimableTransfer.findUnique({ where: { code: params.code } });
    if (!ct) return { status: 'rejected' as const, reason: 'unknown_code' };
    if (ct.status === 'claimed') return { status: 'claimed' as const, transferId: ct.id };
    if (ct.status !== 'unclaimed') return { status: 'rejected' as const, reason: 'claim_' + ct.status };
    if (ct.recipientWaId !== waId) return { status: 'rejected' as const, reason: 'wrong_recipient' };
    if (ct.expiresAt.getTime() < Date.now()) return { status: 'rejected' as const, reason: 'expired' };

    // Resolve or provision the recipient for this WhatsApp number.
    const link = await tx.whatsAppLink.findUnique({ where: { waId }, include: { customer: { include: { wallet: true } } } });
    let recipient: any = link?.customer ?? null;
    if (!recipient) {
      recipient = await tx.customer.create({
        data: {
          axoTag: '@u' + waId.slice(-7),
          displayName: 'Axo user ' + waId.slice(-4),
          country: 'KE', currency: ct.currency, status: 'active',
          wallet: { create: { currency: ct.currency } },
          waLink: { create: { waId, phone: waId, verifiedAt: new Date(), sessionExpiresAt: new Date(Date.now() + 600000) } },
        },
        include: { wallet: true },
      });
    }
    return settleClaim(tx, ct, recipient);
  });
}

/**
 * Claim a pending transfer by VERIFIED IDENTITY instead of the original number.
 * This is what lets someone who lost the phone the money was sent to still
 * receive it: they prove who they are (recovery: Axo ID + email + Axo Code), and
 * the already-verified customer id is passed here. No number match is required —
 * identity is the authority. The caller MUST have completed identity verification
 * before calling; this function trusts customerId as already-proven.
 */
export async function claimByIdentity(params: { code: string; customerId: string }) {
  return inTransaction(async (tx) => {
    const ct = await tx.claimableTransfer.findUnique({ where: { code: params.code } });
    if (!ct) return { status: 'rejected' as const, reason: 'unknown_code' };
    if (ct.status === 'claimed') return { status: 'claimed' as const, transferId: ct.id };
    if (ct.status !== 'unclaimed') return { status: 'rejected' as const, reason: 'claim_' + ct.status };
    if (ct.expiresAt.getTime() < Date.now()) return { status: 'rejected' as const, reason: 'expired' };

    const recipient = await tx.customer.findUniqueOrThrow({ where: { id: params.customerId }, include: { wallet: true } });
    if (recipient.status === 'frozen') return { status: 'rejected' as const, reason: 'account_frozen' };
    return settleClaim(tx, ct, recipient);
  });
}

/** Shared: release the sender reservation and post the two-sided credit. */
async function settleClaim(tx: any, ct: any, recipient: any) {
  const recipientWallet = recipient.wallet ?? (await tx.customerAccount.findFirstOrThrow({ where: { customerId: recipient.id } }));
  const sender = await tx.customer.findUniqueOrThrow({ where: { id: ct.senderId }, include: { wallet: true } });
  await tx.customerAccount.update({ where: { id: sender.wallet!.id }, data: { reservedMinor: { decrement: ct.amountMinor } } });
  await postCustomerLedger(tx, ct.id, [
    { accountId: sender.wallet!.id, direction: 'debit', amountMinor: ct.amountMinor, currency: ct.currency },
    { accountId: recipientWallet.id, direction: 'credit', amountMinor: ct.amountMinor, currency: ct.currency },
  ]);
  const done = await tx.claimableTransfer.update({ where: { id: ct.id }, data: { status: 'claimed', claimedAt: new Date() } });
  return { status: 'claimed' as const, transferId: done.id, recipientId: recipient.id };
}

/**
 * When a customer recovers to a NEW number (lost phone / change number), any
 * money still waiting to be claimed that was addressed to their OLD number is
 * re-pointed to the new number — so a pending claim follows the person, it does
 * not get stranded on a number they no longer control. Returns how many were
 * moved. Call this from the recovery/number-change flow after identity is proven.
 */
export async function repointClaimsToNewNumber(params: { oldWaId: string; newWaId: string }) {
  const oldWa = normalizeWaId(params.oldWaId);
  const newWa = normalizeWaId(params.newWaId);
  if (!oldWa || !newWa) throw new Error('invalid phone');
  const pending = await prisma.claimableTransfer.findMany({ where: { recipientWaId: oldWa, status: 'unclaimed' }, select: { id: true } });
  for (const p of pending) {
    await prisma.claimableTransfer.update({ where: { id: p.id }, data: { recipientWaId: newWa } });
  }
  return { repointed: pending.length };
}

/**
 * Refund an unclaimed send back to the sender — used by the sender recalling it,
 * or by the expiry sweep. Releases the reservation (no balance ever moved for an
 * unclaimed transfer, so there is nothing to reverse, only to un-reserve).
 */
export async function refundClaimable(params: { code: string; by?: 'sender' | 'expiry'; senderId?: string }) {
  return inTransaction(async (tx) => {
    const ct = await tx.claimableTransfer.findUnique({ where: { code: params.code } });
    if (!ct) return { ok: false, reason: 'unknown_code' };
    // A sender recall must come from the person who sent it. Claim codes are
    // short, so without this anyone could recall someone else's money by guessing.
    if (params.by === 'sender' && params.senderId !== ct.senderId) return { ok: false, reason: 'unknown_code' };
    if (ct.status !== 'unclaimed') return { ok: false, reason: 'not_unclaimed' };
    const sender = await tx.customer.findUniqueOrThrow({ where: { id: ct.senderId }, include: { wallet: true } });
    await tx.customerAccount.update({ where: { id: sender.wallet!.id }, data: { reservedMinor: { decrement: ct.amountMinor } } });
    await tx.claimableTransfer.update({ where: { id: ct.id }, data: { status: 'refunded' } });
    return { ok: true };
  });
}

/** Sweep expired unclaimed sends and refund them. Run on a schedule. */
export async function sweepExpiredClaims(now = new Date()) {
  const expired = await prisma.claimableTransfer.findMany({ where: { status: 'unclaimed', expiresAt: { lt: now } }, select: { code: true } });
  let refunded = 0;
  for (const e of expired) {
    const r = await refundClaimable({ code: e.code, by: 'expiry' });
    if (r.ok) refunded++;
  }
  return { refunded };
}
