CREATE TABLE "HarvestExecution" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "yieldAmount" DECIMAL(38,18) NOT NULL,
    "gasCost" DECIMAL(38,18) NOT NULL,
    "netProfit" DECIMAL(38,18) NOT NULL,
    "minimumProfit" DECIMAL(38,18) NOT NULL,
    "status" TEXT NOT NULL,
    "returnAmount" DECIMAL(38,18),
    "transactionHash" TEXT,
    "error" TEXT,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HarvestExecution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HarvestExecution_strategyId_evaluatedAt_idx"
ON "HarvestExecution"("strategyId", "evaluatedAt");

CREATE INDEX "HarvestExecution_status_evaluatedAt_idx"
ON "HarvestExecution"("status", "evaluatedAt");