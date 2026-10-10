import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';
import { postLedger } from '../ledger/ledger.service.js';
import { quoteTransfer, checkTransfer, transferLegs, isClearingTag } from './p2p.lib.js';
import { screenMovement, openCase } from '../risk/risk.service.js';
import { enqueueMerchantEvent } from '../notify/outbox.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sum of a customer's completed+pending sends in the rolling 24h (for limits). */
async function spentToday(tx: PrismaClient, senderId: string): Promise<bigint> {
  const since = new Date(Date.now() - DAY_MS);
  const rows = await tx.p2PTransfer.findMany({
    where: { senderId, status: { in: ['pending', 'completed'] }, createdAt: { gte: since } },
    select: { amountMinor: true },
  });
  return rows.reduce((s: bigint, r: { amountMinor: bigint }) => s + r.amountMinor, 0n);
}

/**
 * Post balanced legs to the CUSTOMER ledger and update cached wallet balances,
 * inside the caller's transaction. Mirrors ledger.service.postLedger exactly:
 * debits == credits, immutable rows, cached balance moved in the same commit.
 */
export async function postCustomerLedger(
  tx: PrismaClient,
  transferId: string,
  legs: Array<{ accountId: string; direction: 'debit' | 'credit'; amountMinor: bigint; currency: string }>,
): Promise<void> {
  if (legs.length < 2) throw new Error('p2p ledger: a posting needs at least two legs');
  let net = 0n;
  for (const leg of legs) {
    if (leg.amountMinor <= 0n) throw new Error('p2p ledger: leg amount must be positive');
    net += leg.direction === 'credit' ? leg.amountMinor : -leg.amountMinor;
  }
  if (net !== 0n) throw new Error(`p2p ledger: legs do not balance (net=${net})`);

  for (const leg of legs) {
    await tx.customerLedgerEntry.create({
      data: {
        transferId,
        source: 'p2p',
        accountId: leg.accountId,
        direction: leg.direction,
        amountMinor: leg.amountMinor,
        currency: leg.currency,
      },
    });
    const delta = leg.direction === 'credit' ? leg.amountMinor : -leg.amountMinor;
    await tx.customerAccount.update({ where: { id: leg.accountId }, data: { balanceMinor: { increment: delta } } });
  }
}

/**
 * The platform's internal customer-side clearing wallet for a currency. It is a
 * real CustomerAccount owned by a reserved system Customer (axoTag
 * "@axo_clearing"), so every customer-ledger posting is two-sided and balances.
 * When a customer pays a merchant, the wallet is debited and this clearing
 * account is credited; the matching credit to the merchant lives in the merchant
 * ledger, and reconciliation asserts the two clearing legs net to zero.
 */
async function clearingWallet(tx: PrismaClient, currency: string) {
  const tag = '@axo_clearing_' + currency.toLowerCase();
  let sys = await tx.customer.findUnique({ where: { axoTag: tag }, include: { wallet: true } });
  if (!sys) {
    sys = await tx.customer.create({
      data: {
        axoTag: tag,
        displayName: 'Axo Clearing (' + currency + ')',
        country: 'XX',
        currency,
        status: 'active',
        kycTier: 'verified',
        wallet: { create: { currency } },
      },
      include: { wallet: true },
    });
  }
  return sys.wallet!;
}

/**
 * Axo-to-Axo transfer between two customers. Server-authoritative end to end:
 * resolve both customers + wallets, quote + limit/balance checks BEFORE moving
 * money, post balanced ledger legs inside one serializable transaction.
 * Idempotent: a repeat idempotencyKey returns the original transfer.
 */
export async function sendP2P(params: {
  senderId: string;
  recipientId: string;
  amountMinor: bigint;
  currency: string;
  note?: string;
  idempotencyKey?: string;
}) {
  return inTransaction(async (tx) => {
    if (params.idempotencyKey) {
      const existing = await tx.p2PTransfer.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
      if (existing) return existing; // replay, never double-send
    }

    const sender = await tx.customer.findUniqueOrThrow({ where: { id: params.senderId }, include: { wallet: true } });
    const recipient = await tx.customer.findUniqueOrThrow({ where: { id: params.recipientId }, include: { wallet: true } });
    if (!sender.wallet || !recipient.wallet) throw new Error('wallet_missing');
    // The clearing wallets are the platform's side of business payments and cash
    // movements, not people. A person-to-person send into or out of one would
    // unbalance the clearing legs against the merchant ledger.
    if (isClearingTag(recipient.axoTag) || isClearingTag(sender.axoTag)) throw new Error('recipient not found');

    const quote = quoteTransfer(params.amountMinor);
    const spendable = sender.wallet.balanceMinor - sender.wallet.reservedMinor;
    const spent = await spentToday(tx, sender.id);
    const check = checkTransfer({
      senderStatus: sender.status,
      recipientStatus: recipient.status,
      senderId: sender.id,
      recipientId: recipient.id,
      currency: params.currency,
      senderCurrency: sender.wallet.currency,
      recipientCurrency: recipient.wallet.currency,
      spendableMinor: spendable,
      spentTodayMinor: spent,
      tier: sender.kycTier as 'basic' | 'verified',
      quote,
    });
    if (!check.ok) throw new Error(check.reason);

    // Risk screen BEFORE money moves. A 'block' refuses and opens a case; a
    // 'review' proceeds but flags a case for an analyst (money still posts, so
    // the sender is not stuck, but it is surfaced for monitoring). Uses the same
    // tx so the facts are consistent.
    const risk = await screenMovement({
      senderCustomerId: sender.id,
      recipientTag: recipient.axoTag,
      amountMinor: quote.amountMinor,
      currency: params.currency,
      tier: sender.kycTier as 'basic' | 'verified',
      client: tx,
    });
    if (risk.decision === 'block') {
      await openCase({ kind: 'transaction_blocked', subjectType: 'customer', subjectId: sender.id, outcome: risk, reason: 'blocked by risk engine' });
      throw new Error('blocked by risk controls: ' + risk.signals.map((s) => s.code).join(', '));
    }

    const transfer = await tx.p2PTransfer.create({
      data: {
        senderId: sender.id,
        recipientId: recipient.id,
        amountMinor: quote.amountMinor,
        feeMinor: quote.feeMinor,
        currency: params.currency,
        status: 'pending',
        note: params.note,
        idempotencyKey: params.idempotencyKey,
      },
    });
    await postCustomerLedger(
      tx,
      transfer.id,
      transferLegs({
        senderAccountId: sender.wallet.id,
        recipientAccountId: recipient.wallet.id,
        amountMinor: quote.amountMinor,
        currency: params.currency,
      }),
    );
    const done = await tx.p2PTransfer.update({ where: { id: transfer.id }, data: { status: 'completed', completedAt: new Date() } });
    if (risk.decision === 'review') {
      await openCase({ kind: 'transaction_review', subjectType: 'transfer', subjectId: done.id, outcome: risk, reason: 'flagged for review' });
    }
    return done;
  });
}

/**
 * A customer pays a BUSINESS (merchant) — the core Axo Business case. One logical
 * payment, posted on both ledgers in the same serializable transaction:
 *  - CUSTOMER ledger: debit the customer wallet, credit the clearing wallet.
 *  - MERCHANT ledger: credit the merchant's axo_balance, debit its clearing.
 * The two clearing legs (customer-side credit, merchant-side debit) are the
 * bridge; the merchant Transaction records the customer transfer's id
 * (transferId) so either half can always find the other.
 *
 * Axo's own ledger is the rail here, so the posting IS the authoritative
 * confirmation: nothing is "pending a provider". The merchant's payment.succeeded
 * event is queued in the same transaction (transactional outbox).
 * Idempotent on idempotencyKey.
 */
export async function payMerchant(params: PayMerchantParams) {
  return inTransaction((tx) => payMerchantTx(tx, params));
}

export interface PayMerchantParams {
  customerId: string;
  merchantId: string;
  amountMinor: bigint;
  currency: string;
  note?: string;
  idempotencyKey?: string;
  // included in the merchant's payment.succeeded event when the payment settles
  // a payment request
  paymentRequest?: { id: string; ref: string; saleRef: string | null };
}

/** payMerchant inside a caller's transaction, so a caller can settle a payment
 *  request and post the payment atomically. */
export async function payMerchantTx(tx: PrismaClient, params: PayMerchantParams) {
  if (params.idempotencyKey) {
    const existing = await tx.p2PTransfer.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
    if (existing) {
      // A replay answers in the SAME shape as the original call.
      const mtxn = await tx.transaction.findUnique({ where: { transferId: existing.id } });
      return { transfer: existing, merchantTransactionId: (mtxn?.id ?? null) as string | null, replayed: true as const };
    }
  }

  const customer = await tx.customer.findUniqueOrThrow({ where: { id: params.customerId }, include: { wallet: true } });
  if (!customer.wallet) throw new Error('wallet_missing');
  const merchant = await tx.merchant.findUniqueOrThrow({ where: { id: params.merchantId } });
  const merchantBalance = await tx.account.findFirst({
    where: { merchantId: merchant.id, type: 'axo_balance', currency: params.currency },
  });
  const merchantClearing = await tx.account.findFirst({
    where: { merchantId: merchant.id, type: 'clearing', currency: params.currency },
  });
  if (!merchantBalance || !merchantClearing) throw new Error('business does not accept ' + params.currency);

  const quote = quoteTransfer(params.amountMinor);
  const spendable = customer.wallet.balanceMinor - customer.wallet.reservedMinor;
  const spent = await spentToday(tx, customer.id);
  const check = checkTransfer({
    senderStatus: customer.status,
    recipientStatus: merchant.accountStatus === 'active' ? 'active' : 'review',
    senderId: customer.id,
    recipientId: 'merchant:' + merchant.id,
    currency: params.currency,
    senderCurrency: customer.wallet.currency,
    recipientCurrency: params.currency,
    spendableMinor: spendable,
    spentTodayMinor: spent,
    tier: customer.kycTier as 'basic' | 'verified',
    quote,
  });
  if (!check.ok) throw new Error(check.reason);

  // Same risk screen as a person-to-person send — paying a business is still
  // money leaving a customer's wallet.
  const risk = await screenMovement({
    senderCustomerId: customer.id,
    recipientTag: merchant.axoId,
    amountMinor: quote.amountMinor,
    currency: params.currency,
    tier: customer.kycTier as 'basic' | 'verified',
    client: tx,
  });
  if (risk.decision === 'block') {
    await openCase({ kind: 'transaction_blocked', subjectType: 'customer', subjectId: customer.id, outcome: risk, reason: 'merchant payment blocked by risk engine' });
    throw new Error('blocked by risk controls: ' + risk.signals.map((s) => s.code).join(', '));
  }

  // Customer-side transfer + two-sided customer ledger posting (wallet → clearing).
  const clearing = await clearingWallet(tx, params.currency);
  const transfer = await tx.p2PTransfer.create({
    data: {
      senderId: customer.id,
      recipientId: clearing.customerId,
      amountMinor: quote.amountMinor,
      feeMinor: 0n,
      currency: params.currency,
      status: 'pending',
      note: `pay ${merchant.tradingName}${params.note ? ' · ' + params.note : ''}`,
      idempotencyKey: params.idempotencyKey,
    },
  });
  await postCustomerLedger(tx, transfer.id, [
    { accountId: customer.wallet.id, direction: 'debit', amountMinor: quote.amountMinor, currency: params.currency },
    { accountId: clearing.id, direction: 'credit', amountMinor: quote.amountMinor, currency: params.currency },
  ]);

  // Business-side transaction (shows in merchant statements, reports, recon).
  const mtxn = await tx.transaction.create({
    data: {
      merchantId: merchant.id,
      type: 'payment_in',
      status: 'confirmed',
      amountMinor: quote.amountMinor,
      currency: params.currency,
      provider: 'axo',
      providerRef: transfer.id,
      transferId: transfer.id,
      customerRef: customer.axoTag,
      confirmedAt: new Date(),
    },
  });
  await postLedger(
    mtxn.id,
    [
      { accountId: merchantBalance.id, direction: 'credit', amountMinor: quote.amountMinor, currency: params.currency },
      { accountId: merchantClearing.id, direction: 'debit', amountMinor: quote.amountMinor, currency: params.currency },
    ],
    tx,
  );

  const done = await tx.p2PTransfer.update({ where: { id: transfer.id }, data: { status: 'completed', completedAt: new Date() } });
  if (risk.decision === 'review') {
    await openCase({ kind: 'transaction_review', subjectType: 'transfer', subjectId: done.id, outcome: risk, reason: 'merchant payment flagged for review' });
  }

  await enqueueMerchantEvent(tx, merchant.id, 'payment.succeeded', {
    transactionId: mtxn.id,
    transferId: done.id,
    amountMinor: quote.amountMinor,
    currency: params.currency,
    customer: { axoTag: customer.axoTag, displayName: customer.displayName },
    note: params.note ?? null,
    paymentRequest: params.paymentRequest ?? null,
    confirmedAt: mtxn.confirmedAt,
  });

  return { transfer: done, merchantTransactionId: mtxn.id as string | null, replayed: false as const };
}

/**
 * Resolve an Axo-issued Till / Paybill number to its merchant. This is how an
 * individual paying "till 832909" or "paybill 600921 RENT" over WhatsApp reaches
 * the right business — exactly the lookup M-Pesa does for its customers, but on
 * Axo's own numbers. For a paybill, the account line must exist and be active.
 */
export async function resolvePayNumber(params: { kind: 'till' | 'paybill' | 'payid'; number: string; account?: string }) {
  const num = params.number.replace(/\s/g, '');
  const pn = await prisma.payNumber.findUnique({
    where: { kind_number: { kind: params.kind, number: num } },
    include: { lines: true },
  });
  if (!pn || !pn.active) return { ok: false as const, reason: 'unknown_or_inactive_number' };
  if (params.kind === 'paybill') {
    const acct = (params.account ?? '').toUpperCase();
    const line = pn.lines.find((l: any) => l.account === acct && l.active);
    if (!line) return { ok: false as const, reason: 'unknown_account_line' };
  }
  return { ok: true as const, merchantId: pn.merchantId, label: pn.label ?? undefined };
}

/**
 * Pay a business by its Till/Paybill number from an Axo wallet — the customer
 * side of "any individual can pay any Axo business like M-Pesa". Resolves the
 * number, then runs the same server-authoritative payMerchant path (ledger,
 * risk screen, idempotency). Returns 'unknown_number' instead of guessing.
 */
export async function payByNumber(params: {
  customerId: string;
  kind: 'till' | 'paybill';
  number: string;
  account?: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey?: string;
}) {
  const r = await resolvePayNumber({ kind: params.kind, number: params.number, account: params.account });
  if (!r.ok) return { status: 'rejected' as const, reason: r.reason };
  const note = params.kind === 'paybill' && params.account ? `a/c ${params.account}` : undefined;
  const result = await payMerchant({
    customerId: params.customerId,
    merchantId: r.merchantId,
    amountMinor: params.amountMinor,
    currency: params.currency,
    note,
    idempotencyKey: params.idempotencyKey,
  });
  return { status: 'completed' as const, ...result, merchantId: r.merchantId };
}

/**
 * A BUSINESS pays an individual's Axo wallet — the mirror of payMerchant, so the
 * two directions are symmetric. Debits the merchant's axo_balance and credits
 * the customer's wallet, both ledgers posted in one serializable transaction
 * (merchant: balance → clearing; customer: clearing → wallet). Used for a
 * refund-to-wallet, a staff/supplier payment to an Axo user, or any
 * business-initiated credit. Idempotent on idempotencyKey.
 */
export async function businessPayCustomer(params: {
  merchantId: string;
  customerId: string;
  amountMinor: bigint;
  currency: string;
  note?: string;
  kind?: 'payout' | 'refund' | 'payment';
  idempotencyKey?: string;
}) {
  return inTransaction(async (tx) => {
    if (params.idempotencyKey) {
      const existing = await tx.p2PTransfer.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
      if (existing) return existing;
    }
    const merchant = await tx.merchant.findUniqueOrThrow({ where: { id: params.merchantId } });
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: params.customerId }, include: { wallet: true } });
    if (!customer.wallet) throw new Error('wallet_missing');
    const merchantBalance = await tx.account.findFirstOrThrow({ where: { merchantId: merchant.id, type: 'axo_balance', currency: params.currency } });
    const merchantClearing = await tx.account.findFirstOrThrow({ where: { merchantId: merchant.id, type: 'clearing', currency: params.currency } });

    if (params.amountMinor <= 0n) throw new Error('amount must be positive');
    if (merchantBalance.balanceMinor < params.amountMinor) throw new Error('insufficient business balance');

    // Merchant side: debit balance, credit clearing.
    const mtxn = await tx.transaction.create({
      data: { merchantId: merchant.id, type: params.kind === 'refund' ? 'refund' : 'payout', status: 'confirmed', amountMinor: params.amountMinor, currency: params.currency, provider: 'axo', customerRef: customer.axoTag, confirmedAt: new Date() },
    });
    await postLedger(mtxn.id, [
      { accountId: merchantBalance.id, direction: 'debit', amountMinor: params.amountMinor, currency: params.currency },
      { accountId: merchantClearing.id, direction: 'credit', amountMinor: params.amountMinor, currency: params.currency },
    ], tx);

    // Customer side: credit wallet from clearing.
    const clearing = await clearingWallet(tx, params.currency);
    const transfer = await tx.p2PTransfer.create({
      data: { senderId: clearing.customerId, recipientId: customer.id, amountMinor: params.amountMinor, feeMinor: 0n, currency: params.currency, status: 'pending', note: `${params.kind ?? 'payment'} from ${merchant.tradingName}${params.note ? ' · ' + params.note : ''}`, idempotencyKey: params.idempotencyKey },
    });
    await postCustomerLedger(tx, transfer.id, [
      { accountId: clearing.id, direction: 'debit', amountMinor: params.amountMinor, currency: params.currency },
      { accountId: customer.wallet.id, direction: 'credit', amountMinor: params.amountMinor, currency: params.currency },
    ]);
    const done = await tx.p2PTransfer.update({ where: { id: transfer.id }, data: { status: 'completed', completedAt: new Date() } });
    return { transfer: done, merchantTransactionId: mtxn.id, customerId: customer.id, from: merchant.tradingName, amountMinor: params.amountMinor, currency: params.currency, kind: params.kind ?? 'payment' };
  });
}
