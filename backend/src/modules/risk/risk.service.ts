import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { assessRisk, isDenylisted, type RiskOutcome } from './risk.lib.js';
import { TIER_LIMITS } from '../p2p/p2p.lib.js';

const HOUR_MS = 60 * 60 * 1000;

/** Load the denylist once per check (small table; a real build caches/streams). */
async function loadDenylist(client?: PrismaClient): Promise<Set<string>> {
  const db = client ?? prisma;
  const rows = await db.denylistEntry.findMany({ select: { value: true } });
  return new Set(rows.map((r: { value: string }) => r.value));
}

/**
 * Screen a customer-initiated movement BEFORE money moves. Gathers the sender's
 * rolling-hour activity and denylist status, runs the pure engine, and returns
 * the decision. The caller (sendP2P / payMerchant / cash-out) enforces it:
 *  - 'allow'  → proceed
 *  - 'review' → proceed but open a case / place on hold per policy
 *  - 'block'  → refuse, open a case
 */
export async function screenMovement(params: {
  senderCustomerId: string;
  recipientTag?: string;        // for P2P
  destination?: string;         // for cash-out
  amountMinor: bigint;
  currency: string;
  tier: 'basic' | 'verified';
  client?: PrismaClient;
}): Promise<RiskOutcome> {
  const db = params.client ?? prisma;
  const since = new Date(Date.now() - HOUR_MS);

  const recent = await db.p2PTransfer.findMany({
    where: { senderId: params.senderCustomerId, createdAt: { gte: since } },
    select: { amountMinor: true, recipientId: true },
  });
  const txnsLastHour = recent.length;
  const sumLastHourMinor = recent.reduce((s: bigint, r: { amountMinor: bigint }) => s + r.amountMinor, 0n);
  const distinctRecipientsLastHour = new Set(recent.map((r: { recipientId: string }) => r.recipientId)).size;

  const denylist = await loadDenylist(db);
  const sender = await db.customer.findUnique({ where: { id: params.senderCustomerId }, select: { axoTag: true } });

  const outcome = assessRisk({
    amountMinor: params.amountMinor,
    currency: params.currency,
    txnsLastHour,
    sumLastHourMinor,
    distinctRecipientsLastHour,
    senderDenylisted: sender ? isDenylisted(sender.axoTag, denylist) : false,
    recipientDenylisted: params.recipientTag ? isDenylisted(params.recipientTag, denylist) : false,
    destinationDenylisted: params.destination ? isDenylisted(params.destination, denylist) : false,
    newRecipient: false, // the caller can refine; omitted keeps the check cheap
    perTxnCeilingMinor: TIER_LIMITS[params.tier].perTxnMinor,
  });
  return outcome;
}

/** Open a risk case (idempotent-ish: one open case per subject+kind is enough). */
export async function openCase(params: {
  kind: 'transaction_review' | 'transaction_blocked' | 'manual_freeze' | 'fraud_report';
  subjectType: string;
  subjectId: string;
  score?: number;
  outcome?: RiskOutcome;
  reason?: string;
  openedBy?: string;
}) {
  return prisma.riskCase.create({
    data: {
      kind: params.kind,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      score: params.score ?? params.outcome?.score ?? 0,
      signalsJson: params.outcome ? JSON.stringify(params.outcome.signals) : null,
      reason: params.reason,
      openedBy: params.openedBy ?? 'system',
      status: params.kind === 'transaction_blocked' ? 'under_review' : 'open',
    },
  });
}

/**
 * Freeze a customer account (no debits until released). Records a case.
 * `operatorId` is remembered so the SAME operator cannot later release it
 * (maker-checker, enforced in releaseFreeze).
 */
export async function freezeCustomer(params: { customerId: string; operatorId: string; reason: string }) {
  const [, kase] = await prisma.$transaction([
    prisma.customer.update({ where: { id: params.customerId }, data: { status: 'frozen' } }),
    prisma.riskCase.create({
      data: {
        kind: 'manual_freeze', subjectType: 'customer', subjectId: params.customerId,
        reason: params.reason, openedBy: params.operatorId, status: 'open',
      },
    }),
  ]);
  return kase;
}

/**
 * Release a freeze. Maker-checker: the releasing operator must differ from the
 * operator who opened the freeze case. Sets the customer back to active.
 */
export async function releaseFreeze(params: { caseId: string; operatorId: string }) {
  const kase = await prisma.riskCase.findUniqueOrThrow({ where: { id: params.caseId } });
  if (kase.kind !== 'manual_freeze') throw new Error('not a freeze case');
  if (kase.status !== 'open' && kase.status !== 'under_review') throw new Error('case is already resolved');
  if (kase.openedBy && kase.openedBy === params.operatorId) {
    throw new Error('maker-checker: the operator who froze cannot release');
  }
  await prisma.$transaction([
    prisma.customer.update({ where: { id: kase.subjectId }, data: { status: 'active' } }),
    prisma.riskCase.update({ where: { id: kase.id }, data: { status: 'cleared', resolvedBy: params.operatorId, resolvedAt: new Date() } }),
  ]);
  return { released: true };
}

/** Analyst resolves a transaction case: clear (allow) or confirm (keep blocked). */
export async function resolveCase(params: { caseId: string; operatorId: string; outcome: 'cleared' | 'confirmed' }) {
  const kase = await prisma.riskCase.findUniqueOrThrow({ where: { id: params.caseId } });
  if (kase.status === 'cleared' || kase.status === 'confirmed') throw new Error('already resolved');
  if (kase.openedBy && kase.openedBy === params.operatorId && kase.openedBy !== 'system') {
    throw new Error('maker-checker: opener cannot resolve their own case');
  }
  return prisma.riskCase.update({
    where: { id: kase.id },
    data: { status: params.outcome, resolvedBy: params.operatorId, resolvedAt: new Date() },
  });
}

export async function addDenylist(params: { value: string; kind: string; reason?: string; addedBy?: string }) {
  const value = params.value.trim().toLowerCase().replace(/\s+/g, '');
  return prisma.denylistEntry.upsert({
    where: { value },
    update: { reason: params.reason, addedBy: params.addedBy },
    create: { value, kind: params.kind, reason: params.reason, addedBy: params.addedBy },
  });
}
