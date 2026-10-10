// Pure, DB-free helpers for merchant webhooks: signing, verification and the
// retry schedule. Exported so a merchant's POS integration (or our tests) can
// verify a delivery exactly the way we sign it.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header carrying the signature on every delivery. */
export const SIGNATURE_HEADER = 'axo-signature';

/** How old a signed timestamp may be before a receiver should reject it (replay window). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** After this many failed attempts a delivery is marked failed and left for ops. */
export const MAX_ATTEMPTS = 8;

/**
 * Sign a payload. The timestamp is part of the signed string, so a captured
 * delivery can't be replayed later with a fresh timestamp.
 * Header format: `t=<unix seconds>,v1=<hex hmac-sha256 of "t.body">`.
 */
export function signPayload(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`, 'utf8').digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

/** Verify a signature header. Returns false on a bad MAC or a stale timestamp. */
export function verifyPayloadSignature(
  secret: string,
  body: string,
  header: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = signPayload(secret, body, t).split('v1=')[1]!;
  const a = Buffer.from(parts.v1, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Delay before the next attempt, after `attempts` failures so far. */
export function nextBackoffMs(attempts: number): number {
  const schedule = [10_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 21_600_000];
  return schedule[Math.min(Math.max(attempts - 1, 0), schedule.length - 1)]!;
}
