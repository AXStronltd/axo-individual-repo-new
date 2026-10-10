import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';
import { pickRamp } from '../../providers/ramp.registry.js';
import { screenMovement, openCase } from '../risk/risk.service.js';

/**
 * The platform clearing wallet for a currency (same one the P2P service uses).
 * Cash-in credits the customer wallet and debits clearing (external money comes
 * in); cash-out debits the customer wallet and credits clearing (money goes out).
 * Either way the customer ledger stays two-sided and balances.
 */
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

/** Post a balanced pair to the customer ledger against a CashTransfer. */
async function postCashLedger(
  tx: PrismaClient,
  cashTransferId: string,
  legs: Array<{ accountId: string; direction: 'debit' | 'credit'; amountMinor: bigint; currency: string }>,
) {
  // Entries anchor to the CashTransfer id with source="cash", so the one
  // customer ledger table serves both P2P and cash flows under one invariant.
  for (const leg of legs) {
    await tx.customerLedgerEntry.create({
      data: { transferId: cashTransferId, source: 'cash', accountId: leg.accountId, direction: leg.direction, amountMinor: leg.amountMinor, currency: leg.currency },
    });
    const delta = leg.direction === 'credit' ? leg.amountMinor : -leg.amountMinor;
    await tx.customerAccount.update({ where: { id: leg.accountId }, data: { balanceMinor: { increment: delta } } });
  }
}

/**
 * Start a CASH-IN: the customer funds their Axo wallet from an external source
 * (e.g. their M-Pesa number). Creates a PENDING record and submits to the ramp.
 * No wallet money moves yet — it only moves when the ramp confirms by webhook.
 * Idempotent on idempotencyKey. Returns { status:'unavailable' } if no configured
 * ramp supports this country/currency, rather than faking success.
 */
export async function startCashIn(params: {
  customerId: string;
  amountMinor: bigint;
  currency: string;
  source: string;
  idempotencyKey?: string;
  providerName?: string;
}) {
  if (params.amountMinor <= 0n) throw new Error('amount must be positive');
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: params.customerId }, include: { wallet: true } });
  if (!customer.wallet) throw new Error('wallet_missing');
  if (customer.status === 'frozen') throw new Error('account is frozen');

  const ramp = pickRamp('cash_in', customer.country, params.currency, params.providerName);
  if (!ramp) return { status: 'unavailable' as const, reason: 'no_ramp_configured' };

  if (params.idempotencyKey) {
    const existing = await prisma.cashTransfer.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
    if (existing) return { status: existing.status, cashTransfer: existing };
  }

  const ct = await prisma.cashTransfer.create({
    data: {
      customerId: customer.id, op: 'cash_in', amountMinor: params.amountMinor, currency: params.currency,
      externalRef: params.source, provider: ramp.name, status: 'pending', idempotencyKey: params.idempotencyKey,
    },
  });
  const res = await ramp.cashIn({ amountMinor: params.amountMinor, currency: params.currency, source: params.source, reference: ct.id });
  if (res.status !== 'accepted') {
    await prisma.cashTransfer.update({ where: { id: ct.id }, data: { status: 'failed' } });
    return { status: 'failed' as const, reason: res.reason };
  }
  const updated = await prisma.cashTransfer.update({ where: { id: ct.id }, data: { providerRef: res.providerRef } });
  return { status: 'pending' as const, cashTransfer: updated };
}

/**
 * Start a CASH-OUT: the customer withdraws Axo value to an external destination.
 * Funds are RESERVED immediately (so they can't be double-spent while in flight),
 * then submitted to the ramp. The actual debit is applied when the ramp confirms;
 * if the ramp rejects or the webhook reports failure, the reservation is released.
 */
export async function startCashOut(params: {
  customerId: string;
  amountMinor: bigint;
  currency: string;
  destination: string;
  idempotencyKey?: string;
  providerName?: string;
}) {
  if (params.amountMinor <= 0n) throw new Error('amount must be positive');

  const ramp0 = pickRamp('cash_out', (await prisma.customer.findUniqueOrThrow({ where: { id: params.customerId } })).country, params.currency, params.providerName);
  if (!ramp0) return { status: 'unavailable' as const, reason: 'no_ramp_configured' };

  const ct = await inTransaction(async (tx) => {
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: params.customerId }, include: { wallet: true } });
    if (!customer.wallet) throw new Error('wallet_missing');
    if (customer.status === 'frozen') throw new Error('account is frozen');

    if (params.idempotencyKey) {
      const existing = await tx.cashTransfer.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
      if (existing) return existing;
    }

    const spendable = customer.wallet.balanceMinor - customer.wallet.reservedMinor;
    if (params.amountMinor > spendable) throw new Error('insufficient funds');

    // Risk screen the OFF-RAMP (money leaving the network is the higher-risk path).
    const risk = await screenMovement({
      senderCustomerId: customer.id,
      destination: params.destination,
      amountMinor: params.amountMinor,
      currency: params.currency,
      tier: customer.kycTier as 'basic' | 'verified',
      client: tx,
    });
    if (risk.decision === 'block') {
      await openCase({ kind: 'transaction_blocked', subjectType: 'customer', subjectId: customer.id, outcome: risk, reason: 'cash-out blocked by risk engine' });
      throw new Error('blocked by risk controls: ' + risk.signals.map((s) => s.code).join(', '));
    }

    // Reserve (does not change balanceMinor, only makes it unspendable).
    await tx.customerAccount.update({ where: { id: customer.wallet.id }, data: { reservedMinor: { increment: params.amountMinor } } });
    return tx.cashTransfer.create({
      data: {
        customerId: customer.id, op: 'cash_out', amountMinor: params.amountMinor, currency: params.currency,
        externalRef: params.destination, provider: ramp0.name, status: 'pending', idempotencyKey: params.idempotencyKey,
      },
    });
  });

  if ('status' in ct && ct.status !== 'pending') return { status: ct.status, cashTransfer: ct };

  const res = await ramp0.cashOut({ amountMinor: params.amountMinor, currency: params.currency, destination: params.destination, reference: ct.id });
  if (res.status !== 'accepted') {
    // release the reservation
    await inTransaction(async (tx) => {
      await tx.customerAccount.update({ where: { customerId: params.customerId }, data: { reservedMinor: { decrement: params.amountMinor } } });
      await tx.cashTransfer.update({ where: { id: ct.id }, data: { status: 'failed' } });
    });
    return { status: 'failed' as const, reason: res.reason };
  }
  const updated = await prisma.cashTransfer.update({ where: { id: ct.id }, data: { providerRef: res.providerRef } });
  return { status: 'pending' as const, cashTransfer: updated };
}

/**
 * Apply a verified ramp webhook. Confirms or fails the matching CashTransfer and
 * moves the wallet accordingly — this is the ONLY place a cash movement actually
 * credits/debits the wallet. Idempotent: a duplicate webhook (same provider+ref,
 * already-terminal status) is a no-op.
 */
export async function applyRampWebhook(params: {
  provider: string;
  providerRef: string;
  op: 'cash_in' | 'cash_out';
  outcome: 'confirmed' | 'failed';
}) {
  return inTransaction(async (tx) => {
    const ct = await tx.cashTransfer.findUnique({ where: { provider_providerRef: { provider: params.provider, providerRef: params.providerRef } } });
    if (!ct) return { applied: false, reason: 'unknown_ref' };
    if (ct.status !== 'pending') return { applied: false, reason: 'already_' + ct.status }; // de-dup / replay guard

    const customer = await tx.customer.findUniqueOrThrow({ where: { id: ct.customerId }, include: { wallet: true } });
    const wallet = customer.wallet!;
    const clearing = await clearingWallet(tx, ct.currency);

    if (params.outcome === 'failed') {
      if (ct.op === 'cash_out') {
        // release reservation; no balance change
        await tx.customerAccount.update({ where: { id: wallet.id }, data: { reservedMinor: { decrement: ct.amountMinor } } });
      }
      return finalize(tx, ct.id, 'failed');
    }

    if (ct.op === 'cash_in') {
      // external money in: credit wallet, debit clearing
      await postCashLedger(tx, ct.id, [
        { accountId: wallet.id, direction: 'credit', amountMinor: ct.amountMinor, currency: ct.currency },
        { accountId: clearing.id, direction: 'debit', amountMinor: ct.amountMinor, currency: ct.currency },
      ]);
    } else {
      // money out: release the reservation, then debit wallet, credit clearing
      await tx.customerAccount.update({ where: { id: wallet.id }, data: { reservedMinor: { decrement: ct.amountMinor } } });
      await postCashLedger(tx, ct.id, [
        { accountId: wallet.id, direction: 'debit', amountMinor: ct.amountMinor, currency: ct.currency },
        { accountId: clearing.id, direction: 'credit', amountMinor: ct.amountMinor, currency: ct.currency },
      ]);
    }
    return finalize(tx, ct.id, 'confirmed');
  });
}

async function finalize(tx: PrismaClient, id: string, status: 'confirmed' | 'failed') {
  const row = await tx.cashTransfer.update({ where: { id }, data: { status, confirmedAt: status === 'confirmed' ? new Date() : null } });
  return { applied: true, status: row.status, cashTransfer: row };
}
