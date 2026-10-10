import type { PrismaClient } from '@prisma/client';
import { prisma, inTransaction } from '../../db/client.js';
import { hashSecret, verifySecret } from '../auth/hash.js';
import { generateOtp } from './whatsapp.lib.js';

const OTP_TTL_MS = 5 * 60 * 1000;      // codes expire in 5 minutes
const SESSION_TTL_MS = 10 * 60 * 1000; // a verified step-up session lasts 10 minutes

/**
 * Issue a one-time code for a WhatsApp number. The code is returned ONLY so the
 * caller (the message gateway) can hand it to the outbound WhatsApp sender; it is
 * stored as an argon2id hash, never in plaintext. Any unconsumed prior challenge
 * for the same waId+purpose is invalidated first.
 */
export async function issueOtp(waId: string, purpose: 'link' | 'stepup'): Promise<{ code: string; expiresAt: Date }> {
  const code = generateOtp(6);
  const codeHash = await hashSecret(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await inTransaction(async (tx) => {
    await tx.otpChallenge.updateMany({
      where: { waId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.otpChallenge.create({ data: { waId, purpose, codeHash, expiresAt } });
  });
  return { code, expiresAt };
}

export type OtpResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'too_many_attempts' | 'no_challenge' | 'wrong_code' };

/**
 * Verify a submitted code. Enforces expiry and an attempt cap, and consumes the
 * challenge on success so a code can never be replayed. Constant work regardless
 * of outcome where it matters (argon2 verify).
 */
export async function verifyOtp(waId: string, purpose: 'link' | 'stepup', code: string): Promise<OtpResult> {
  const challenge = await prisma.otpChallenge.findFirst({
    where: { waId, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!challenge) return { ok: false, reason: 'no_challenge' };
  if (challenge.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (challenge.attempts >= challenge.maxAttempts) return { ok: false, reason: 'too_many_attempts' };

  const good = await verifySecret(challenge.codeHash, code);
  if (!good) {
    await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: 'wrong_code' };
  }
  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
  return { ok: true };
}

/**
 * Link a verified WhatsApp number to a customer and open a step-up session.
 * Called only after verifyOtp succeeds. WhatsApp identity alone never authorizes
 * money — a live (unexpired) session, minted here, is also required for sends.
 */
export async function confirmLink(waId: string, customerId: string): Promise<void> {
  const now = new Date();
  const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await inTransaction(async (tx) => {
    await tx.whatsAppLink.upsert({
      where: { customerId },
      update: { waId, verifiedAt: now, sessionExpiresAt },
      create: { customerId, waId, phone: waId, verifiedAt: now, sessionExpiresAt },
    });
    await tx.customer.update({ where: { id: customerId }, data: { status: 'active' } });
  });
}

/** A send is only authorized if the linked number has a live, verified session. */
export async function hasLiveSession(waId: string, client?: PrismaClient): Promise<boolean> {
  const db = client ?? prisma;
  const link = await db.whatsAppLink.findUnique({ where: { waId } });
  return !!(link && link.verifiedAt && link.sessionExpiresAt && link.sessionExpiresAt.getTime() > Date.now());
}

/** Refresh the step-up session (e.g. after a successful stepup OTP). */
export async function refreshSession(waId: string): Promise<void> {
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.whatsAppLink.update({ where: { waId }, data: { sessionExpiresAt } });
}

/**
 * Record an inbound webhook event id for de-duplication. Returns true if this is
 * the first time we have seen it (i.e. process it), false if it is a duplicate
 * delivery (WhatsApp retries) — in which case the caller must skip processing.
 */
export async function claimWebhookEvent(eventId: string): Promise<boolean> {
  try {
    await prisma.webhookEvent.create({ data: { id: eventId, provider: 'whatsapp' } });
    return true;
  } catch {
    return false; // unique violation => already processed
  }
}

/** Resolve the customer for a verified WhatsApp number, or null. */
export async function customerForWaId(waId: string) {
  const link = await prisma.whatsAppLink.findUnique({ where: { waId }, include: { customer: { include: { wallet: true } } } });
  return link?.customer ?? null;
}
