// Pure, DB-free logic for Axo-to-Axo (P2P) transfers.
// Kept separate from the service so it can be unit-tested without a database,
// the same split used by batches (batch.lib.ts vs batches.service.ts).

export interface P2PQuote {
  amountMinor: bigint;
  feeMinor: bigint;
  totalMinor: bigint; // what leaves the sender = amount + fee
}

export interface TierLimits {
  perTxnMinor: bigint;
  dailyMinor: bigint;
}

// Limits by KYC tier. A phone-verified ("basic") wallet is deliberately capped;
// ID-verified ("verified") gets higher limits. Values are placeholders a
// compliance config would own in production.
export const TIER_LIMITS: Record<'basic' | 'verified', TierLimits> = {
  basic: { perTxnMinor: 20_000_00n, dailyMinor: 50_000_00n },
  verified: { perTxnMinor: 1_000_000_00n, dailyMinor: 5_000_000_00n },
};

/**
 * Axo-to-Axo transfers between participating customers are free by design (the
 * whole point vs a ~2% telco till). A fee hook exists for cross-tier or
 * cross-border cases a provider would price; default is zero.
 */
export function quoteTransfer(amountMinor: bigint, feeMinor: bigint = 0n): P2PQuote {
  if (amountMinor <= 0n) throw new Error('amount must be positive');
  if (feeMinor < 0n) throw new Error('fee cannot be negative');
  return { amountMinor, feeMinor, totalMinor: amountMinor + feeMinor };
}

export type TransferCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a transfer against account state and limits BEFORE any money moves.
 * Pure function: callers pass in the facts, so it is trivially testable and
 * cannot be fooled by anything the client sent.
 */
export function checkTransfer(params: {
  senderStatus: string;
  recipientStatus: string;
  senderId: string;
  recipientId: string;
  currency: string;
  senderCurrency: string;
  recipientCurrency: string;
  spendableMinor: bigint;      // sender available balance (balance - reserved)
  spentTodayMinor: bigint;     // sender's total sent in the rolling day
  tier: 'basic' | 'verified';
  quote: P2PQuote;
}): TransferCheck {
  const p = params;
  if (p.senderId === p.recipientId) return { ok: false, reason: 'cannot send to yourself' };
  if (p.senderStatus === 'frozen') return { ok: false, reason: 'sender account is frozen' };
  if (p.senderStatus !== 'active') return { ok: false, reason: 'sender account is not active' };
  if (p.recipientStatus === 'frozen') return { ok: false, reason: 'recipient account is frozen' };
  if (p.recipientStatus !== 'active') return { ok: false, reason: 'recipient cannot receive right now' };
  // No silent FX here: a transfer must be same-currency unless a provider path
  // handles the conversion explicitly (not in this phase).
  if (p.currency !== p.senderCurrency || p.currency !== p.recipientCurrency) {
    return { ok: false, reason: 'currency mismatch — cross-currency needs a provider route' };
  }
  const limits = TIER_LIMITS[p.tier];
  if (p.quote.amountMinor > limits.perTxnMinor) {
    return { ok: false, reason: 'amount exceeds per-transaction limit for your verification tier' };
  }
  if (p.spentTodayMinor + p.quote.amountMinor > limits.dailyMinor) {
    return { ok: false, reason: 'this would exceed your daily limit' };
  }
  if (p.quote.totalMinor > p.spendableMinor) {
    return { ok: false, reason: 'insufficient funds' };
  }
  return { ok: true };
}

/**
 * The balanced ledger legs for a completed P2P transfer. Debit the sender's
 * wallet, credit the recipient's. (Fees, when non-zero, would add a third leg
 * to a revenue account; omitted while fee defaults to zero.)
 * Convention matches ledger.service: credit adds, debit subtracts.
 */
export function transferLegs(params: {
  senderAccountId: string;
  recipientAccountId: string;
  amountMinor: bigint;
  currency: string;
}): Array<{ accountId: string; direction: 'debit' | 'credit'; amountMinor: bigint; currency: string }> {
  return [
    { accountId: params.senderAccountId, direction: 'debit', amountMinor: params.amountMinor, currency: params.currency },
    { accountId: params.recipientAccountId, direction: 'credit', amountMinor: params.amountMinor, currency: params.currency },
  ];
}

/**
 * Legs for a customer paying a BUSINESS (merchant). This is the core business
 * case: a customer pays over WhatsApp and the money lands in the merchant's
 * axo_balance account — no telco till in between. Debit the customer's wallet,
 * credit the merchant's Axo balance account.
 */
export function customerToMerchantLegs(params: {
  customerAccountId: string;      // CustomerAccount id (wallet side)
  merchantAccountId: string;      // merchant Account id (axo_balance)
  amountMinor: bigint;
  currency: string;
}): {
  customerLeg: { accountId: string; direction: 'debit'; amountMinor: bigint; currency: string };
  merchantLeg: { accountId: string; direction: 'credit'; amountMinor: bigint; currency: string };
} {
  return {
    customerLeg: { accountId: params.customerAccountId, direction: 'debit', amountMinor: params.amountMinor, currency: params.currency },
    merchantLeg: { accountId: params.merchantAccountId, direction: 'credit', amountMinor: params.amountMinor, currency: params.currency },
  };
}

// A valid Axo tag: @ + 3-20 lowercase alphanumerics/underscore.
const TAG_RE = /^@[a-z0-9_]{3,20}$/;
export function normalizeTag(input: string): string | null {
  if (!input) return null;
  let t = input.trim().toLowerCase();
  if (!t.startsWith('@')) t = '@' + t;
  return TAG_RE.test(t) ? t : null;
}

// E.164-ish normalization for a WhatsApp number → the digits we key on.
export function normalizeWaId(input: string): string | null {
  if (!input) return null;
  const digits = input.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/** The tag prefix of the platform's internal clearing wallets (one per currency). */
export const CLEARING_TAG_PREFIX = '@axo_clearing';

/** Is this the internal clearing wallet rather than a real person? */
export function isClearingTag(tag: string): boolean {
  return tag.startsWith(CLEARING_TAG_PREFIX);
}
