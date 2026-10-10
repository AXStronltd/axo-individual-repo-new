-- CreateEnum
CREATE TYPE "KybTier" AS ENUM ('micro', 'registered');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'review', 'suspended');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'manager', 'cashier', 'accountant');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('fiat_settlement', 'axo_balance', 'wallet_usdc', 'wallet_usdt', 'clearing');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "TxnType" AS ENUM ('payment_in', 'payout', 'refund', 'reversal', 'bill', 'credit_draw', 'credit_repay', 'p2p_transfer', 'cash_in', 'cash_out');

-- CreateEnum
CREATE TYPE "TxnStatus" AS ENUM ('awaiting_approval', 'pending', 'confirmed', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "ReconStatus" AS ENUM ('matched', 'unmatched', 'mismatch', 'unexpected');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('draft', 'approved', 'executing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "BatchItemStatus" AS ENUM ('queued', 'paid', 'failed');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('unverified', 'active', 'review', 'frozen');

-- CreateEnum
CREATE TYPE "CustomerKycTier" AS ENUM ('basic', 'verified');

-- CreateEnum
CREATE TYPE "P2PStatus" AS ENUM ('pending', 'completed', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "CashStatus" AS ENUM ('pending', 'confirmed', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "CashOp" AS ENUM ('cash_in', 'cash_out');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "AgentTxnKind" AS ENUM ('cash_in', 'cash_out', 'float_topup');

-- CreateEnum
CREATE TYPE "BillerKind" AS ENUM ('airtime', 'electricity', 'water', 'tv', 'internet', 'other');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('unclaimed', 'claimed', 'refunded');

-- CreateEnum
CREATE TYPE "PushStatus" AS ENUM ('pending', 'approved', 'declined', 'expired');

-- CreateEnum
CREATE TYPE "PayNumberKind" AS ENUM ('till', 'paybill', 'payid');

-- CreateEnum
CREATE TYPE "RiskCaseStatus" AS ENUM ('open', 'under_review', 'cleared', 'confirmed');

-- CreateEnum
CREATE TYPE "RiskCaseKind" AS ENUM ('transaction_review', 'transaction_blocked', 'manual_freeze', 'fraud_report');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradingName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "axoId" TEXT NOT NULL,
    "kybTier" "KybTier" NOT NULL DEFAULT 'micro',
    "kybStatus" TEXT NOT NULL DEFAULT 'pending',
    "accountStatus" "AccountStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL DEFAULT 'owner',
    "passwordHash" TEXT NOT NULL,
    "axoCodeHash" TEXT,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "currency" TEXT NOT NULL,
    "balanceMinor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "type" "TxnType" NOT NULL,
    "status" "TxnStatus" NOT NULL DEFAULT 'pending',
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'axo',
    "providerRef" TEXT,
    "idempotencyKey" TEXT,
    "customerRef" TEXT,
    "reversesId" TEXT,
    "makerId" TEXT,
    "checkerId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "settlementId" TEXT,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "subtotalMinor" BIGINT NOT NULL,
    "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "method" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "responseJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'draft',
    "makerId" TEXT,
    "checkerId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "BatchItemStatus" NOT NULL DEFAULT 'queued',
    "transactionId" TEXT,
    "error" TEXT,

    CONSTRAINT "BatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "actualMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "reconStatus" "ReconStatus" NOT NULL DEFAULT 'unmatched',
    "matchedTxnId" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Counter" (
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("merchantId","name")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "axoTag" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "CustomerStatus" NOT NULL DEFAULT 'unverified',
    "kycTier" "CustomerKycTier" NOT NULL DEFAULT 'basic',
    "pinHash" TEXT,
    "pinFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAccount" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "balanceMinor" BIGINT NOT NULL DEFAULT 0,
    "reservedMinor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerLedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'p2p',
    "direction" "Direction" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppLink" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "sessionExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpChallenge" (
    "id" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "P2PTransfer" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "status" "P2PStatus" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "idempotencyKey" TEXT,
    "reversesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "P2PTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashTransfer" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "op" "CashOp" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "status" "CashStatus" NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "CashTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'active',
    "floatMinor" BIGINT NOT NULL DEFAULT 0,
    "commissionMinor" BIGINT NOT NULL DEFAULT 0,
    "commissionBps" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTxn" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" "AgentTxnKind" NOT NULL,
    "customerId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "commissionMinor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTxn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillerPurchase" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" "BillerKind" NOT NULL,
    "target" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "token" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillerPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimableTransfer" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientWaId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "note" TEXT,
    "status" "ClaimStatus" NOT NULL DEFAULT 'unclaimed',
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "ClaimableTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingConfirm" (
    "id" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "toTag" TEXT,
    "toPhone" TEXT,
    "number" TEXT,
    "account" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "note" TEXT,
    "summary" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingConfirm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingPayIntent" (
    "id" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "number" TEXT,
    "account" TEXT,
    "pushRef" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingPayIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushPrompt" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT,
    "targetWaId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "account" TEXT,
    "status" "PushStatus" NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PushPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayNumber" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "kind" "PayNumberKind" NOT NULL,
    "number" TEXT NOT NULL,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayNumberLine" (
    "id" TEXT NOT NULL,
    "payNumberId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PayNumberLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskCase" (
    "id" TEXT NOT NULL,
    "kind" "RiskCaseKind" NOT NULL,
    "status" "RiskCaseStatus" NOT NULL DEFAULT 'open',
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "signalsJson" TEXT,
    "reason" TEXT,
    "openedBy" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DenylistEntry" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DenylistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_axoId_key" ON "Merchant"("axoId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_merchantId_idx" ON "User"("merchantId");

-- CreateIndex
CREATE INDEX "Account_merchantId_idx" ON "Account"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_merchantId_type_currency_key" ON "Account"("merchantId", "type", "currency");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_idx" ON "LedgerEntry"("accountId");

-- CreateIndex
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");

-- CreateIndex
CREATE INDEX "Transaction_merchantId_idx" ON "Transaction"("merchantId");

-- CreateIndex
CREATE INDEX "Transaction_status_idx" ON "Transaction"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_provider_providerRef_key" ON "Transaction"("provider", "providerRef");

-- CreateIndex
CREATE INDEX "Invoice_merchantId_idx" ON "Invoice"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_merchantId_number_key" ON "Invoice"("merchantId", "number");

-- CreateIndex
CREATE INDEX "InvoicePayment_invoiceId_idx" ON "InvoicePayment"("invoiceId");

-- CreateIndex
CREATE INDEX "IdempotencyKey_merchantId_idx" ON "IdempotencyKey"("merchantId");

-- CreateIndex
CREATE INDEX "Batch_merchantId_idx" ON "Batch"("merchantId");

-- CreateIndex
CREATE INDEX "BatchItem_batchId_idx" ON "BatchItem"("batchId");

-- CreateIndex
CREATE INDEX "Settlement_merchantId_idx" ON "Settlement"("merchantId");

-- CreateIndex
CREATE INDEX "Settlement_reconStatus_idx" ON "Settlement"("reconStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_provider_providerRef_key" ON "Settlement"("provider", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_axoTag_key" ON "Customer"("axoTag");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAccount_customerId_key" ON "CustomerAccount"("customerId");

-- CreateIndex
CREATE INDEX "CustomerLedgerEntry_accountId_idx" ON "CustomerLedgerEntry"("accountId");

-- CreateIndex
CREATE INDEX "CustomerLedgerEntry_transferId_idx" ON "CustomerLedgerEntry"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppLink_customerId_key" ON "WhatsAppLink"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppLink_waId_key" ON "WhatsAppLink"("waId");

-- CreateIndex
CREATE INDEX "WhatsAppLink_waId_idx" ON "WhatsAppLink"("waId");

-- CreateIndex
CREATE INDEX "OtpChallenge_waId_idx" ON "OtpChallenge"("waId");

-- CreateIndex
CREATE UNIQUE INDEX "P2PTransfer_idempotencyKey_key" ON "P2PTransfer"("idempotencyKey");

-- CreateIndex
CREATE INDEX "P2PTransfer_senderId_idx" ON "P2PTransfer"("senderId");

-- CreateIndex
CREATE INDEX "P2PTransfer_recipientId_idx" ON "P2PTransfer"("recipientId");

-- CreateIndex
CREATE INDEX "P2PTransfer_status_idx" ON "P2PTransfer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CashTransfer_idempotencyKey_key" ON "CashTransfer"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CashTransfer_customerId_idx" ON "CashTransfer"("customerId");

-- CreateIndex
CREATE INDEX "CashTransfer_status_idx" ON "CashTransfer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CashTransfer_provider_providerRef_key" ON "CashTransfer"("provider", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_code_key" ON "Agent"("code");

-- CreateIndex
CREATE INDEX "Agent_status_idx" ON "Agent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTxn_idempotencyKey_key" ON "AgentTxn"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentTxn_agentId_idx" ON "AgentTxn"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "BillerPurchase_idempotencyKey_key" ON "BillerPurchase"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillerPurchase_customerId_idx" ON "BillerPurchase"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimableTransfer_code_key" ON "ClaimableTransfer"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimableTransfer_idempotencyKey_key" ON "ClaimableTransfer"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ClaimableTransfer_recipientWaId_idx" ON "ClaimableTransfer"("recipientWaId");

-- CreateIndex
CREATE INDEX "ClaimableTransfer_status_idx" ON "ClaimableTransfer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PendingConfirm_waId_key" ON "PendingConfirm"("waId");

-- CreateIndex
CREATE INDEX "PendingConfirm_waId_idx" ON "PendingConfirm"("waId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingPayIntent_waId_key" ON "PendingPayIntent"("waId");

-- CreateIndex
CREATE INDEX "PendingPayIntent_waId_idx" ON "PendingPayIntent"("waId");

-- CreateIndex
CREATE UNIQUE INDEX "PushPrompt_ref_key" ON "PushPrompt"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "PushPrompt_idempotencyKey_key" ON "PushPrompt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PushPrompt_merchantId_idx" ON "PushPrompt"("merchantId");

-- CreateIndex
CREATE INDEX "PushPrompt_status_idx" ON "PushPrompt"("status");

-- CreateIndex
CREATE INDEX "PayNumber_merchantId_idx" ON "PayNumber"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "PayNumber_kind_number_key" ON "PayNumber"("kind", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PayNumberLine_payNumberId_account_key" ON "PayNumberLine"("payNumberId", "account");

-- CreateIndex
CREATE INDEX "RiskCase_status_idx" ON "RiskCase"("status");

-- CreateIndex
CREATE INDEX "RiskCase_subjectType_subjectId_idx" ON "RiskCase"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "DenylistEntry_value_key" ON "DenylistEntry"("value");

-- CreateIndex
CREATE INDEX "AuditLog_merchantId_idx" ON "AuditLog"("merchantId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchItem" ADD CONSTRAINT "BatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAccount" ADD CONSTRAINT "CustomerAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLedgerEntry" ADD CONSTRAINT "CustomerLedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppLink" ADD CONSTRAINT "WhatsAppLink_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "P2PTransfer" ADD CONSTRAINT "P2PTransfer_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "P2PTransfer" ADD CONSTRAINT "P2PTransfer_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTxn" ADD CONSTRAINT "AgentTxn_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayNumberLine" ADD CONSTRAINT "PayNumberLine_payNumberId_fkey" FOREIGN KEY ("payNumberId") REFERENCES "PayNumber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
