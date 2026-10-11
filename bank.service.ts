import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';
import crypto from 'node:crypto';

// How long a deposit reference stays valid before it lapses.
const INTENT_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * BANK COLLECTION — fund an Axo wallet from a bank account.
 *
 * Two ways a deposit is confirmed, both landing in the SAME credit path:
 *   - automated: a verified bank/RTGS webhook calls confirmBankDeposit(..., 'auto')
 *   - manual:    ops matches a statement line and calls confirmBankDeposit(..., 'manual')
 *
 * The wallet is only ever credited on a confirmation, never on the intent, and
 * crediting is idempotent (a second confirmation of the same reference is a no-op).
 * Settlement reuses the cash-in ledger: credit the customer wallet, debit the
 * per-currency clearing wallet, recorded as a CashTransfer (provider "bank").
 */

function depositReference(bank: string): string {
  // Short, human-quotable, collision-checked by the @unique column at write time.
  const rand = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  return 'AXO-' + bank.toUpperCase().slice(0, 4) + '-' + rand;
}

/** The per-currency clearing wallet (same one P2P and cash use). */
async function clearingWallet(tx: PrismaClient, currency: string) {
  const tag = '@axo_clearing_' + currency.toLowerCase();
  let sys = await tx.customer.findUnique({ where: { axoTag: tag }, include: { wallet: true } });
  if (!sys) {
    sys = await tx.customer.create({
      data: {
        axoTag: tag, displayName: 'Axo Clearing (' + currency + ')', country: 'XX',
        currency, status: 'active', kycTier: 'verified', wallet: { create: { currency } },
      },
      include: { wallet: true },
    });
  }
  return sys.wallet!;
}

/**
 * Step 1 — the customer asks to add money from their bank. We issue a unique
 * reference and return it with the amount; the app shows it next to the Axo
 * collection-account details. No money moves. Idempotent on idempotencyKey.
 */
export async function createBankDepositIntent(params: {
  customerId: string;
  amountMinor: bigint;
  currency: string;
  bank: string;
  idempotencyKey?: string;
}) {
  if (params.amountMinor <= 0n) throw new Error('amount must be positive');
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: params.customerId }, include: { wallet: true } });
  if (!customer.wallet) throw new Error('wallet_missing');
  if (customer.status === 'frozen') throw new Error('account is frozen');

  if (params.idempotencyKey) {
    const existing = await prisma.bankDepositIntent.findFirst({ where: { customerId: customer.id, status: 'awaiting', amountMinor: params.amountMinor, currency: params.currency, bank: params.bank } });
    if (existing) return existing;
  }

  // Generate a reference, retrying on the rare unique collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = depositReference(params.bank);
    try {
      return await prisma.bankDepositIntent.create({
        data: {
          customerId: customer.id,
          amountMinor: params.amountMinor,
          currency: params.currency,
          bank: params.bank,
          reference,
          status: 'awaiting',
          expiresAt: new Date(Date.now() + INTENT_TTL_MS),
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') continue; // reference clash — try another
      throw e;
    }
  }
  throw new Error('could_not_allocate_reference');
}

/**
 * Step 2 — confirm a deposit and credit the wallet. Called with mode 'auto' from
 * a verified bank webhook, or 'manual' from ops after matching a statement line.
 * Idempotent: an already-credited reference returns without re-crediting.
 * amountMinor (what the bank actually received) is authoritative over the intent.
 */
export async function confirmBankDeposit(params: {
  reference: string;
  amountMinor: bigint;
  currency: string;
  bankRef?: string;     // the bank's own transaction id, stored for audit/dedup
  mode: 'auto' | 'manual';
}) {
  return inTransaction(async (tx) => {
    const intent = await tx.bankDepositIntent.findUnique({ where: { reference: params.reference } });
    if (!intent) return { applied: false as const, reason: 'unknown_reference' };
    if (intent.status === 'credited') return { applied: false as const, reason: 'already_credited', cashTransferId: intent.cashTransferId };
    if (intent.status !== 'awaiting') return { applied: false as const, reason: 'intent_' + intent.status };
    if (intent.currency !== params.currency) return { applied: false as const, reason: 'currency_mismatch' };

    const customer = await tx.customer.findUniqueOrThrow({ where: { id: intent.customerId }, include: { wallet: true } });
    if (customer.status === 'frozen') return { applied: false as const, reason: 'account_frozen' };
    const wallet = customer.wallet!;
    const clearing = await clearingWallet(tx, params.currency);

    // Record the movement as a CashTransfer (provider "bank") so bank collection
    // shows up in the same cash history and under the same ledger invariant.
    const ct = await tx.cashTransfer.create({
      data: {
        customerId: customer.id, op: 'cash_in', amountMinor: params.amountMinor, currency: params.currency,
        externalRef: 'bank:' + params.reference, provider: 'bank', providerRef: params.bankRef ?? params.reference,
        status: 'confirmed', confirmedAt: new Date(),
      },
    });

    // External money in: credit the customer wallet, debit clearing (two-sided).
    for (const leg of [
      { accountId: wallet.id, direction: 'credit' as const, amountMinor: params.amountMinor },
      { accountId: clearing.id, direction: 'debit' as const, amountMinor: params.amountMinor },
    ]) {
      await tx.customerLedgerEntry.create({
        data: { transferId: ct.id, source: 'cash', accountId: leg.accountId, direction: leg.direction, amountMinor: leg.amountMinor, currency: params.currency },
      });
      const delta = leg.direction === 'credit' ? leg.amountMinor : -leg.amountMinor;
      await tx.customerAccount.update({ where: { id: leg.accountId }, data: { balanceMinor: { increment: delta } } });
    }

    const done = await tx.bankDepositIntent.update({
      where: { id: intent.id },
      data: { status: 'credited', cashTransferId: ct.id, confirmedMode: params.mode, confirmedAt: new Date() },
    });
    return { applied: true as const, status: 'credited' as const, reference: done.reference, cashTransferId: ct.id, customerId: customer.id, amountMinor: params.amountMinor };
  });
}

/** Cancel an awaiting intent (user changed their mind, or ops voids it). */
export async function cancelBankDepositIntent(params: { reference: string }) {
  return inTransaction(async (tx) => {
    const intent = await tx.bankDepositIntent.findUnique({ where: { reference: params.reference } });
    if (!intent) return { ok: false as const, reason: 'unknown_reference' };
    if (intent.status !== 'awaiting') return { ok: false as const, reason: 'intent_' + intent.status };
    await tx.bankDepositIntent.update({ where: { id: intent.id }, data: { status: 'cancelled' } });
    return { ok: true as const };
  });
}

/** Sweep references that lapsed with no matching deposit. Run on a schedule. */
export async function sweepExpiredBankIntents(now = new Date()) {
  const expired = await prisma.bankDepositIntent.findMany({ where: { status: 'awaiting', expiresAt: { lt: now } }, select: { id: true } });
  for (const e of expired) {
    await prisma.bankDepositIntent.update({ where: { id: e.id }, data: { status: 'expired' } });
  }
  return { expired: expired.length };
}
