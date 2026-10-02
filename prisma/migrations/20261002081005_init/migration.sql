-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('USER', 'STORE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TransferType" AS ENUM ('PAYMENT', 'TOPUP');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "balanceCents" BIGINT NOT NULL DEFAULT 0,
    "type" "AccountType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "secretKeyHash" TEXT NOT NULL,
    "webhookUrl" TEXT,
    "webhookSigningSecret" TEXT NOT NULL,
    "webhookAlertOwedAt" TIMESTAMP(3),
    "webhookAlertSentAt" TIMESTAMP(3),
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "returnUrl" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "type" "TransferType" NOT NULL,
    "topupIdempotencyKey" TEXT,
    "requestHash" TEXT,
    "fromAccountId" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentId" TEXT,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'PENDING',
    "lockedUntil" TIMESTAMP(3),
    "lastTried" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastResponseStatus" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "paymentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_accountId_key" ON "User"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Store_email_key" ON "Store"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Store_secretKeyHash_key" ON "Store"("secretKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "Store_accountId_key" ON "Store"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_storeId_key" ON "Payment"("idempotencyKey", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_paymentId_key" ON "Transfer"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_toAccountId_topupIdempotencyKey_key" ON "Transfer"("toAccountId", "topupIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_paymentId_key" ON "WebhookEvent"("paymentId");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_nextAttemptAt_idx" ON "WebhookEvent"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add Non Zero Balance Check

ALTER TABLE "Account" ADD CONSTRAINT "Account_balance_non_negative_unless_system"
    CHECK("balanceCents">=0 OR "type"='SYSTEM');

-- A successful payment has a userId, and only successful payments have one

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_iff_success"
    CHECK(("status"='SUCCESS') = ("userId" IS NOT NULL));

-- Amounts are always positive

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_positive"
    CHECK("amountCents" > 0);

ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_amount_positive"
    CHECK("amountCents" > 0);

-- An account can't transfer to itself

ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_from_not_to"
    CHECK("fromAccountId" <> "toAccountId");

-- PAYMENT transfers link to a payment, and only they do

ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_paymentId_iff_payment"
    CHECK(("type"='PAYMENT') = ("paymentId" IS NOT NULL));

-- TOPUP transfers carry an idempotency key and request hash, and only they do

ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_topupKey_iff_topup"
    CHECK(("type"='TOPUP') = ("topupIdempotencyKey" IS NOT NULL));

ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_requestHash_iff_topup"
    CHECK(("type"='TOPUP') = ("requestHash" IS NOT NULL));

-- DELIVERED events have a delivery time, and only they do

ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_deliveredAt_iff_delivered"
    CHECK(("status"='DELIVERED') = ("deliveredAt" IS NOT NULL));

-- One active (pending or successful) payment per store order; a new one is allowed after expiry

CREATE UNIQUE INDEX "Payment_storeId_orderId_active_key"
    ON "Payment"("storeId", "orderId")
    WHERE "status" IN ('PENDING', 'SUCCESS');