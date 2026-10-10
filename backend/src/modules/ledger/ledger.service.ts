import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';

export interface LedgerLeg {
  accountId: string;
  direction: 'debit' | 'credit';
  amountMinor: bigint;
  currency: string;
}

/**
 * Post a balanced set of ledger legs for one transaction, inside a single DB
 * transaction. Enforces the core invariant: debits == credits. Updates each
 * affected account's cached balance in the same commit. Never deletes anything.
 *
 * Convention: a `credit` increases an asset-style account balance (money in),
 * a `debit` decreases it (money out). This is consistent across the system so
 * the balance math is simply: credit adds, debit subtracts.
 */
export async function postLedger(
  transactionId: string,
  legs: LedgerLeg[],
  client?: PrismaClient,
): Promise<void> {
  if (legs.length < 2) {
    throw new Error('ledger: a posting needs at least two legs');
  }

  // Invariant: total debits must equal total credits (sum to zero).
  let net = 0n;
  for (const leg of legs) {
    if (leg.amountMinor <= 0n) throw new Error('ledger: leg amount must be positive');
    net += leg.direction === 'credit' ? leg.amountMinor : -leg.amountMinor;
  }
  if (net !== 0n) {
    throw new Error(`ledger: legs do not balance (net=${net.toString()})`);
  }

  const run = async (tx: PrismaClient) => {
    for (const leg of legs) {
      await tx.ledgerEntry.create({
        data: {
          transactionId,
          accountId: leg.accountId,
          direction: leg.direction,
          amountMinor: leg.amountMinor,
          currency: leg.currency,
        },
      });
      const delta = leg.direction === 'credit' ? leg.amountMinor : -leg.amountMinor;
      await tx.account.update({
        where: { id: leg.accountId },
        data: { balanceMinor: { increment: delta } },
      });
    }
  };

  if (client) await run(client);
  else await inTransaction(run);
}

/** Recompute an account's balance from its entries. Used by the integrity check. */
export async function ledgerBalance(accountId: string, client?: PrismaClient): Promise<bigint> {
  const db = client ?? prisma;
  const entries = await db.ledgerEntry.findMany({ where: { accountId } });
  let bal = 0n;
  for (const e of entries) {
    bal += e.direction === 'credit' ? e.amountMinor : -e.amountMinor;
  }
  return bal;
}

/** Assert the cached balance equals the ledger sum for an account. */
export async function assertBalanceIntegrity(accountId: string, client?: PrismaClient): Promise<void> {
  const db = client ?? prisma;
  const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
  const computed = await ledgerBalance(accountId, db);
  if (account.balanceMinor !== computed) {
    throw new Error(
      `ledger integrity: account ${accountId} cached=${account.balanceMinor} computed=${computed}`,
    );
  }
}
