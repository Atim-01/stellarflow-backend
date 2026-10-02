-- Migration: add_remittance_transaction
-- Issue #815: /api/v1/remittance/history endpoint
-- Creates the remittance_transaction table with compound indexes optimised
-- for cursor-based pagination filtered by userId, status, asset, and date range.

CREATE TABLE "RemittanceTransaction" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "asset"           VARCHAR(20) NOT NULL,
    "senderCurrency"  VARCHAR(10) NOT NULL,
    "receiverCurrency" VARCHAR(10) NOT NULL,
    "amount"          DECIMAL(24,10) NOT NULL,
    "outputAmount"    DECIMAL(24,10) NOT NULL,
    "fee"             DECIMAL(24,10) NOT NULL DEFAULT 0,
    "rate"            DECIMAL(24,10) NOT NULL,
    "status"          VARCHAR(20) NOT NULL,
    "provider"        VARCHAR(128),
    "stellarTxHash"   TEXT,
    "reference"       VARCHAR(128),
    "errorMessage"    TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemittanceTransaction_pkey" PRIMARY KEY ("id")
);

-- Primary query: filter by userId + status + date range (cursor pagination)
CREATE INDEX "RemittanceTransaction_userId_status_createdAt_idx"
    ON "RemittanceTransaction" ("userId", "status", "createdAt");

-- Filter by userId + asset + date range
CREATE INDEX "RemittanceTransaction_userId_asset_createdAt_idx"
    ON "RemittanceTransaction" ("userId", "asset", "createdAt");

-- Broadest filter: userId + date range only
CREATE INDEX "RemittanceTransaction_userId_createdAt_idx"
    ON "RemittanceTransaction" ("userId", "createdAt");

-- Status-only scans (admin dashboards, reporting)
CREATE INDEX "RemittanceTransaction_status_createdAt_idx"
    ON "RemittanceTransaction" ("status", "createdAt");

-- Asset-level reporting
CREATE INDEX "RemittanceTransaction_asset_createdAt_idx"
    ON "RemittanceTransaction" ("asset", "createdAt");
