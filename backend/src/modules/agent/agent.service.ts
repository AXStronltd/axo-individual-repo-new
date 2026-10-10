import type { PrismaClient } from '@prisma/client';
import { inTransaction } from '../../db/client.js';
import { postCustomerLedger } from '../p2p/p2p.service.js';
import { agentCommission, checkAgentFloat } from './agent.lib.js';

/** The platform clearing wallet for a currency (shared with p2p/cash services). */
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
 * AGENT CASH-IN: a customer hands the agent physical cash; the agent credits the
 * customer's Axo wallet from its float. Settles INSTANTLY against the agent's
 * float — no telco, no external provider. The agent earns commission.
 *   agent.float −= amount ; customer.wallet += amount ; agent.commission += fee
 */
export async function agentCashIn(params: {
  agentCode: string;
  customerId: string;
  amountMinor: bigint;
  idempotencyKey?: string;
}) {
  return inTransaction(async (tx) => {
    if (params.idempotencyKey) {
      const existing = await tx.agentTxn.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
      if (existing) return existing;
    }
    const agent = await tx.agent.findUniqueOrThrow({ where: { code: params.agentCode } });
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: params.customerId }, include: { wallet: true } });
    if (!customer.wallet) throw new Error('wallet_missing');
    if (customer.status === 'frozen') throw new Error('customer account is frozen');

    const check = checkAgentFloat({ kind: 'cash_in', amountMinor: params.amountMinor, floatMinor: agent.floatMinor, status: agent.status });
    if (!check.ok) throw new Error(check.reason);

    const fee = agentCommission(params.amountMinor, agent.commissionBps);

    // Agent float down; customer wallet up (customer ledger: credit wallet vs clearing).
    await tx.agent.update({ where: { id: agent.id }, data: { floatMinor: { decrement: params.amountMinor }, commissionMinor: { increment: fee } } });
    const clearing = await clearingWallet(tx, agent.currency);
    const at = await tx.agentTxn.create({
      data: { agentId: agent.id, kind: 'cash_in', customerId: customer.id, amountMinor: params.amountMinor, commissionMinor: fee, currency: agent.currency, idempotencyKey: params.idempotencyKey },
    });
    await postCustomerLedger(tx, at.id, [
      { accountId: customer.wallet.id, direction: 'credit', amountMinor: params.amountMinor, currency: agent.currency },
      { accountId: clearing.id, direction: 'debit', amountMinor: params.amountMinor, currency: agent.currency },
    ]);
    return at;
  });
}

/**
 * AGENT CASH-OUT: a customer withdraws cash; the agent pays physical cash and
 * takes the Axo value into its float.
 *   customer.wallet −= amount ; agent.float += amount ; agent.commission += fee
 */
export async function agentCashOut(params: {
  agentCode: string;
  customerId: string;
  amountMinor: bigint;
  idempotencyKey?: string;
}) {
  return inTransaction(async (tx) => {
    if (params.idempotencyKey) {
      const existing = await tx.agentTxn.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
      if (existing) return existing;
    }
    const agent = await tx.agent.findUniqueOrThrow({ where: { code: params.agentCode } });
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: params.customerId }, include: { wallet: true } });
    if (!customer.wallet) throw new Error('wallet_missing');
    if (customer.status === 'frozen') throw new Error('customer account is frozen');

    const check = checkAgentFloat({ kind: 'cash_out', amountMinor: params.amountMinor, floatMinor: agent.floatMinor, status: agent.status });
    if (!check.ok) throw new Error(check.reason);

    const spendable = customer.wallet.balanceMinor - customer.wallet.reservedMinor;
    if (params.amountMinor > spendable) throw new Error('insufficient funds');

    const fee = agentCommission(params.amountMinor, agent.commissionBps);

    await tx.agent.update({ where: { id: agent.id }, data: { floatMinor: { increment: params.amountMinor }, commissionMinor: { increment: fee } } });
    const clearing = await clearingWallet(tx, agent.currency);
    const at = await tx.agentTxn.create({
      data: { agentId: agent.id, kind: 'cash_out', customerId: customer.id, amountMinor: params.amountMinor, commissionMinor: fee, currency: agent.currency, idempotencyKey: params.idempotencyKey },
    });
    await postCustomerLedger(tx, at.id, [
      { accountId: customer.wallet.id, direction: 'debit', amountMinor: params.amountMinor, currency: agent.currency },
      { accountId: clearing.id, direction: 'credit', amountMinor: params.amountMinor, currency: agent.currency },
    ]);
    return at;
  });
}

/** Top up an agent's float (Axo delivers liquidity; settled off-platform). */
export async function agentFloatTopup(params: { agentCode: string; amountMinor: bigint }) {
  return inTransaction(async (tx) => {
    const agent = await tx.agent.findUniqueOrThrow({ where: { code: params.agentCode } });
    await tx.agent.update({ where: { id: agent.id }, data: { floatMinor: { increment: params.amountMinor } } });
    return tx.agentTxn.create({ data: { agentId: agent.id, kind: 'float_topup', amountMinor: params.amountMinor, currency: agent.currency } });
  });
}
