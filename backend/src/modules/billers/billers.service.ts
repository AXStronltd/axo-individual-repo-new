import type { PrismaClient } from '@prisma/client';
import { inTransaction } from '../../db/client.js';
import { postCustomerLedger } from '../p2p/p2p.service.js';
import crypto from 'node:crypto';
import { isLive } from '../../config/env.js';

/** The platform clearing wallet (shared with p2p/cash/agent). */
async function clearingWallet(tx: PrismaClient, currency: string) {
  const tag = '@axo_clearing_' + currency.toLowerCase();
  let sys = await tx.customer.findUnique({ where: { axoTag: tag }, include: { wallet: true } });
  if (!sys) {
    sys = await tx.customer.create({
      data: { axoTag: tag, displayName: 'Axo Clearing (' + currency + ')', country: 'XX', currency, status: 'active', kycTier: 'verified', wallet: { create: { currency } } },
      include: { wallet: true },
    });
  }
  return sys.wallet!;
}

/** A 20-digit electricity token (KPLC-style), grouped in fours. */
function electricityToken(): string {
  let d = '';
  while (d.length < 20) d += crypto.randomInt(0, 10).toString();
  return d.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}

/**
 * Buy airtime or pay a utility bill from the wallet. Debits the customer wallet
 * (wallet → clearing) through the same double-entry ledger, records the purchase,
 * and for electricity returns a token to enter on the meter. Idempotent.
 * The external biller is a provider; in production this calls its API and
 * confirms on its callback — here it settles against the wallet immediately.
 */
export async function buyBiller(params: {
  customerId: string;
  kind: 'airtime' | 'electricity' | 'water' | 'tv' | 'internet' | 'other';
  target: string;        // phone to top up, or utility account/meter
  amountMinor: bigint;
  currency: string;
  idempotencyKey?: string;
}) {
  if (params.amountMinor <= 0n) throw new Error('amount must be positive');
  // No biller aggregator is integrated. The sandbox below debits the wallet and
  // invents an electricity token, which is fine for a demo and unacceptable with
  // real money — so in live it refuses until a real biller provider is wired in.
  if (isLive) throw new Error('bill payments are not available yet');
  return inTransaction(async (tx) => {
    if (params.idempotencyKey) {
      const existing = await tx.billerPurchase.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
      if (existing) return existing;
    }
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: params.customerId }, include: { wallet: true } });
    if (!customer.wallet) throw new Error('wallet_missing');
    if (customer.status === 'frozen') throw new Error('account is frozen');
    const spendable = customer.wallet.balanceMinor - customer.wallet.reservedMinor;
    if (params.amountMinor > spendable) throw new Error('insufficient funds');

    const token = params.kind === 'electricity' ? electricityToken() : null;
    const purchase = await tx.billerPurchase.create({
      data: { customerId: customer.id, kind: params.kind, target: params.target, amountMinor: params.amountMinor, currency: params.currency, token, idempotencyKey: params.idempotencyKey, status: 'completed' },
    });

    // Debit the wallet against clearing (money leaves to the biller provider).
    const clearing = await clearingWallet(tx, params.currency);
    // Anchor the ledger entries to the purchase id (source "biller").
    await tx.customerLedgerEntry.create({ data: { transferId: purchase.id, source: 'biller', accountId: customer.wallet.id, direction: 'debit', amountMinor: params.amountMinor, currency: params.currency } });
    await tx.customerAccount.update({ where: { id: customer.wallet.id }, data: { balanceMinor: { decrement: params.amountMinor } } });
    await tx.customerLedgerEntry.create({ data: { transferId: purchase.id, source: 'biller', accountId: clearing.id, direction: 'credit', amountMinor: params.amountMinor, currency: params.currency } });
    await tx.customerAccount.update({ where: { id: clearing.id }, data: { balanceMinor: { increment: params.amountMinor } } });

    return purchase;
  });
}
