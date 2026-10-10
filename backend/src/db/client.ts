import { PrismaClient } from '@prisma/client';

// Single Prisma instance across the app.
export const prisma = new PrismaClient();

// Run a function inside a serializable DB transaction. Money operations use this
// so that ledger writes and balance updates commit together or not at all.
export function inTransaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // Prisma interactive transaction; cast keeps the ledger code readable.
  return prisma.$transaction((tx: unknown) => fn(tx as PrismaClient), {
    isolationLevel: 'Serializable',
  });
}
