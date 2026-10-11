import { prisma, inTransaction } from '../../db/client.js';
import { env } from '../../config/env.js';
import { clearingWallet, postCashLedger } from './cash.service.js';
import { accountAccepts, collectionAccounts, depositReference, normalizeReference, type CollectionAccount } from './bank.lib.js';

// How long a deposit reference stays open before it lapses.
const INTENT_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * BANK COLLECTION — fund an Axo wallet by ordinary bank transfer.
 *
 * 1. The customer asks to add money: we issue a reference and show the
 *    configured collection account. Nothing moves.
 * 2. The customer transfers from their bank, quoting the reference.
 * 3. The deposit is CONFIRMED — by the collection bank's signed webhook ('auto')
 *    or by a platform operator matching a statement line ('manual'). Only then
 *    is the wallet credited, through the same ledger posting as any cash-in:
 *    credit the customer wallet, debit the currency's clearing wallet, recorded
 *    as a CashTransfer with provider "bank".
 *
 * Crediting is exactly-once: a reference credits at most once (status guard),
 * and a bank transaction id credits at most one reference (unique providerRef).
 */

export class BankDepositError extends Error {}

export function bankAccounts(): Record<string, CollectionAccount> {
  return collectionAccounts(env.BANK_COLLECTION_ACCOUNTS, env.APP_ENV);
}

/** Step 1 — issue a reference for MY wallet. Idempotent per customer + key. */
export async function createBankDepositIntent(params: {
  customerId: string;
  amountMinor: bigint;
  bank: string;
  idempotencyKey: string;
}) {
  if (params.amountMinor <= 0n) throw new BankDepositError('amount_must_be_positive');
  const bank = params.bank.toLowerCase();
  const account = bankAccounts()[bank];
  if (!account) throw new BankDepositError('unknown_bank');

  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: params.customerId }, include: { wallet: true } });
  if (!customer.wallet) throw new BankDepositError('wallet_missing');
  if (customer.status === 'frozen') throw new BankDepositError('account_frozen');
  const currency = customer.wallet.currency;
  if (!accountAccepts(account, currency)) throw new BankDepositError('currency_not_accepted');

  const existing = await prisma.bankDepositIntent.findUnique({
    where: { customerId_idempotencyKey: { customerId: customer.id, idempotencyKey: params.idempotencyKey } },
  });
  if (existing) return { intent: existing, account: bankAccounts()[existing.bank] ?? account, replayed: true };

  // A reference can clash with an existing one (one in a million); draw again.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const intent = await prisma.bankDepositIntent.create({
        data: {
          customerId: customer.id, amountMinor: params.amountMinor, currency, bank,
          reference: depositReference(bank), status: 'awaiting', idempotencyKey: params.idempotencyKey,
          expiresAt: new Date(Date.now() + INTENT_TTL_MS),
        },
      });
      return { intent, account, replayed: false };
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e;
      // Either the reference clashed, or a duplicate request with this key won the race.
      const raced = await prisma.bankDepositIntent.findUnique({
        where: { customerId_idempotencyKey: { customerId: customer.id, idempotencyKey: params.idempotencyKey } },
      });
      if (raced) return { intent: raced, account, replayed: true };
    }
  }
  throw new BankDepositError('could_not_allocate_reference');
}

/**
 * Step 3 — a deposit arrived: credit the wallet. `amountMinor` is what the bank
 * actually received and is what gets credited (it may differ from the intent).
 * A reference that already expired is still credited — the money is real — but
 * a cancelled one is not and needs an operator to resolve.
 */
export async function confirmBankDeposit(params: {
  reference: string;
  amountMinor: bigint;
  currency: string;
  bank?: string;        // which collection account received it (webhooks always say)
  bankRef?: string;     // the bank's own transaction id
  mode: 'auto' | 'manual';
}) {
  if (params.amountMinor <= 0n) return { applied: false as const, reason: 'bad_amount' };
  const reference = normalizeReference(params.reference);
  return inTransaction(async (tx) => {
    const intent = await tx.bankDepositIntent.findUnique({ where: { reference } });
    if (!intent) return { applied: false as const, reason: 'unknown_reference' };
    if (params.bank && params.bank.toLowerCase() !== intent.bank) return { applied: false as const, reason: 'bank_mismatch' };
    if (intent.status === 'credited') return { applied: false as const, reason: 'already_credited', cashTransferId: intent.cashTransferId };
    if (intent.status === 'cancelled') return { applied: false as const, reason: 'intent_cancelled' };
    if (intent.currency !== params.currency.toUpperCase()) return { applied: false as const, reason: 'currency_mismatch' };

    const providerRef = params.bankRef ? `${intent.bank}:${params.bankRef}` : `ref:${intent.reference}`;
    const used = await tx.cashTransfer.findUnique({ where: { provider_providerRef: { provider: 'bank', providerRef } } });
    if (used) return { applied: false as const, reason: 'bank_ref_already_used' };

    const customer = await tx.customer.findUniqueOrThrow({ where: { id: intent.customerId }, include: { wallet: true } });
    if (customer.status === 'frozen') return { applied: false as const, reason: 'account_frozen' };
    const clearing = await clearingWallet(tx, intent.currency);

    const ct = await tx.cashTransfer.create({
      data: {
        customerId: customer.id, op: 'cash_in', amountMinor: params.amountMinor, currency: intent.currency,
        externalRef: `bank:${intent.bank}:${intent.reference}`, provider: 'bank', providerRef,
        status: 'confirmed', confirmedAt: new Date(),
      },
    });
    await postCashLedger(tx, ct.id, [
      { accountId: customer.wallet!.id, direction: 'credit', amountMinor: params.amountMinor, currency: intent.currency },
      { accountId: clearing.id, direction: 'debit', amountMinor: params.amountMinor, currency: intent.currency },
    ]);
    await tx.bankDepositIntent.update({
      where: { id: intent.id },
      data: { status: 'credited', cashTransferId: ct.id, confirmedMode: params.mode, confirmedAt: new Date() },
    });
    return {
      applied: true as const, status: 'credited' as const, reference: intent.reference, cashTransferId: ct.id,
      customerId: customer.id, amountMinor: params.amountMinor, currency: intent.currency,
    };
  });
}

/** Cancel an awaiting reference. With `customerId`, only that customer's own. */
export async function cancelBankDepositIntent(params: { reference: string; customerId?: string }) {
  const reference = normalizeReference(params.reference);
  return inTransaction(async (tx) => {
    const intent = await tx.bankDepositIntent.findUnique({ where: { reference } });
    if (!intent || (params.customerId && intent.customerId !== params.customerId)) return { ok: false as const, reason: 'unknown_reference' };
    if (intent.status !== 'awaiting') return { ok: false as const, reason: 'intent_' + intent.status };
    await tx.bankDepositIntent.update({ where: { id: intent.id }, data: { status: 'cancelled' } });
    return { ok: true as const };
  });
}

/** Lapse references whose window passed with no deposit. Run on a schedule. */
export async function sweepExpiredBankIntents(now = new Date()) {
  const r = await prisma.bankDepositIntent.updateMany({ where: { status: 'awaiting', expiresAt: { lt: now } }, data: { status: 'expired' } });
  return { expired: r.count };
}
