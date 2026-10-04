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


CREATE UNIQUE INDEX "Account_single_system_key" ON "Account"(type) WHERE type = 'SYSTEM';
