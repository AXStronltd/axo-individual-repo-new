import { PrismaClient } from '@prisma/client';

// Single Prisma instance across the app.
export const prisma = new PrismaClient();

// Enough headroom for a burst of payments to one shop (see test/concurrency.e2e.test.ts).
const MAX_ATTEMPTS = 10;

/**
 * Errors that mean "another transaction got there first — run me again":
 *  - P2034: Postgres aborted this SERIALIZABLE transaction for conflicting with
 *    a concurrent one (e.g. two customers paying the same shop at once, both
 *    updating its balance row). Postgres expects the application to retry.
 *  - P2002: a unique key was taken by a transaction that committed meanwhile
 *    (e.g. two first-ever payments both creating a currency's clearing wallet,
 *    or a duplicate request racing its original). On the re-run the code finds
 *    the committed row and takes its normal path — the replay for a duplicate.
 */
export function isRetryableTxError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === 'P2034' || code === 'P2002';
}

/**
 * Run a function inside a serializable DB transaction, so ledger writes and
 * balance updates commit together or not at all — and retry it when Postgres
 * reports a conflict with a concurrent transaction. Retrying is safe: a failed
 * attempt is rolled back completely, so each run starts from committed state.
 * `fn` must therefore not have side effects outside `tx` that matter if repeated.
 */
export async function inTransaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      // Prisma interactive transaction; cast keeps the ledger code readable.
      return await prisma.$transaction((tx: unknown) => fn(tx as PrismaClient), {
        isolationLevel: 'Serializable',
      });
    } catch (e) {
      if (!isRetryableTxError(e) || attempt >= MAX_ATTEMPTS) throw e;
      // Jittered back-off so the contenders don't collide again in lockstep.
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(800, 25 * 2 ** attempt)));
    }
  }
}
