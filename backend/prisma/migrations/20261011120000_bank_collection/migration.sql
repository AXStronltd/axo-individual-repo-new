-- CreateEnum
CREATE TYPE "BankDepositStatus" AS ENUM ('awaiting', 'credited', 'expired', 'cancelled');

-- CreateTable
CREATE TABLE "BankDepositIntent" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "bank" TEXT NOT NULL,
    "status" "BankDepositStatus" NOT NULL DEFAULT 'awaiting',
    "idempotencyKey" TEXT,
    "cashTransferId" TEXT,
    "confirmedMode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "BankDepositIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankDepositIntent_reference_key" ON "BankDepositIntent"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "BankDepositIntent_cashTransferId_key" ON "BankDepositIntent"("cashTransferId");

-- CreateIndex
CREATE INDEX "BankDepositIntent_customerId_idx" ON "BankDepositIntent"("customerId");

-- CreateIndex
CREATE INDEX "BankDepositIntent_status_idx" ON "BankDepositIntent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BankDepositIntent_customerId_idempotencyKey_key" ON "BankDepositIntent"("customerId", "idempotencyKey");

