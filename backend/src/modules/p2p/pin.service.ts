import { prisma } from '../../db/client.js';
import { hashSecret, verifySecret } from '../auth/hash.js';

const MAX_PIN_FAILURES = 5;

/** A PIN is 4–6 digits. Pure check so callers can validate before hashing. */
export function isValidPinFormat(pin: string): boolean {
  return /^\d{4,6}$/.test(pin);
}

/** Set (or change) a customer's transaction PIN. Stored as an argon2id hash. */
export async function setPin(customerId: string, pin: string) {
  if (!isValidPinFormat(pin)) throw new Error('PIN must be 4–6 digits');
  const pinHash = await hashSecret(pin);
  await prisma.customer.update({ where: { id: customerId }, data: { pinHash, pinFailures: 0 } });
  return { ok: true };
}

export type PinCheck =
  | { ok: true }
  | { ok: false; reason: 'no_pin_set' | 'locked' | 'wrong_pin' };

/**
 * Verify a PIN as step-up before a money action. Caps failed attempts: after
 * MAX_PIN_FAILURES the account is frozen (a human must release it), matching how
 * M-Pesa blocks after repeated wrong PINs. A correct PIN resets the counter.
 */
export async function verifyPin(customerId: string, pin: string): Promise<PinCheck> {
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  if (!c.pinHash) return { ok: false, reason: 'no_pin_set' };
  if (c.status === 'frozen') return { ok: false, reason: 'locked' };
  if (c.pinFailures >= MAX_PIN_FAILURES) return { ok: false, reason: 'locked' };

  const good = await verifySecret(c.pinHash, pin);
  if (!good) {
    const failures = c.pinFailures + 1;
    const data: any = { pinFailures: failures };
    if (failures >= MAX_PIN_FAILURES) data.status = 'frozen'; // lock out after too many
    await prisma.customer.update({ where: { id: customerId }, data });
    return { ok: false, reason: 'wrong_pin' };
  }
  if (c.pinFailures > 0) await prisma.customer.update({ where: { id: customerId }, data: { pinFailures: 0 } });
  return { ok: true };
}

export async function hasPin(customerId: string): Promise<boolean> {
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { pinHash: true } });
  return !!c?.pinHash;
}
