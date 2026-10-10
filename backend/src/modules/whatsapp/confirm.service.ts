import { prisma } from '../../db/client.js';
import { verifyPin, hasPin } from '../p2p/pin.service.js';

const CONFIRM_TTL_MS = 2 * 60 * 1000; // a staged confirmation lives 2 minutes

export interface StageInput {
  waId: string;
  action: 'send' | 'send_phone' | 'pay_till' | 'pay_bill';
  amountMinor: bigint;
  currency: string;
  summary: string;
  toTag?: string;
  toPhone?: string;
  number?: string;
  account?: string;
  note?: string;
}

/** Stage a money action awaiting confirmation. Replaces any prior pending one. */
export async function stageConfirm(i: StageInput) {
  await prisma.pendingConfirm.deleteMany({ where: { waId: i.waId } });
  return prisma.pendingConfirm.create({
    data: {
      waId: i.waId, action: i.action, amountMinor: i.amountMinor, currency: i.currency,
      summary: i.summary, toTag: i.toTag, toPhone: i.toPhone, number: i.number,
      account: i.account, note: i.note, expiresAt: new Date(Date.now() + CONFIRM_TTL_MS),
    },
  });
}

export type ConfirmResolution =
  | { ok: true; action: any }
  | { ok: false; reason: 'none' | 'expired' | 'wrong_pin' | 'locked' | 'need_pin' };

/**
 * Resolve a pending confirmation. `secret` is what the user replied: their PIN,
 * or "YES" when no PIN is set. Checks the PIN (M-Pesa-style) before releasing
 * the action for the router to execute. Consumes the pending record on success.
 */
export async function resolveConfirm(waId: string, customerId: string, secret: string): Promise<ConfirmResolution> {
  const p = await prisma.pendingConfirm.findUnique({ where: { waId } });
  if (!p) return { ok: false, reason: 'none' };
  if (p.expiresAt.getTime() < Date.now()) {
    await prisma.pendingConfirm.delete({ where: { waId } }).catch(() => {});
    return { ok: false, reason: 'expired' };
  }

  // If the user has a PIN, require it. If not, a plain YES confirms (and we'll
  // nudge them to set one). A PIN-looking secret is always checked when set.
  if (await hasPin(customerId)) {
    if (!/^\d{4,6}$/.test(secret)) return { ok: false, reason: 'need_pin' };
    const v = await verifyPin(customerId, secret);
    if (!v.ok) return { ok: false, reason: v.reason === 'locked' ? 'locked' : 'wrong_pin' };
  }

  await prisma.pendingConfirm.delete({ where: { waId } }).catch(() => {});
  return { ok: true, action: p };
}

export async function cancelConfirm(waId: string) {
  await prisma.pendingConfirm.deleteMany({ where: { waId } });
}

export async function hasPendingConfirm(waId: string): Promise<boolean> {
  const p = await prisma.pendingConfirm.findUnique({ where: { waId } });
  return !!(p && p.expiresAt.getTime() >= Date.now());
}

export { hasPin };
