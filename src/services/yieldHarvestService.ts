export type HarvestExecutionStatus = "EXECUTED" | "SKIPPED" | "FAILED";

export interface HarvestResult {
  returnAmount?: number;
  transactionHash?: string;
}

export interface HarvestStrategy {
  harvest(): Promise<HarvestResult>;
}

export interface YieldOpportunity {
  strategyId: string;
  asset: string;
  yieldAmount: number;
  gasCost: number;
  strategy: HarvestStrategy;
}

export interface YieldOpportunitySource {
  getOpportunities(): Promise<YieldOpportunity[]>;
}

export interface HarvestAnalyticsRecord {
  strategyId: string;
  asset: string;
  yieldAmount: number;
  gasCost: number;
  netProfit: number;
  profitRatio: number;
  minimumProfit: number;
  minimumProfitRatio: number;
  status: HarvestExecutionStatus;
  returnAmount?: number;
  transactionHash?: string;
  error?: string;
  evaluatedAt: Date;
  executedAt?: Date;
}

export interface HarvestAnalyticsRepository {
  recordHarvest(record: HarvestAnalyticsRecord): Promise<void>;
}

export interface HarvestEvaluation {
  strategyId: string;
  asset: string;
  netProfit: number;
  status: HarvestExecutionStatus;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MINIMUM_PROFIT_RATIO = 3.0;

export function createPrismaHarvestAnalyticsRepository(database: {
  harvestExecution: {
    create(args: { data: HarvestAnalyticsRecord }): Promise<unknown>;
  };
}): HarvestAnalyticsRepository {
  return {
    recordHarvest: (record) =>
      database.harvestExecution.create({ data: record }).then(() => undefined),
  };
}

export class YieldHarvestDaemon {
  private timer: ReturnType<typeof setInterval> | undefined;
  private evaluating = false;

  constructor(
    private readonly source: YieldOpportunitySource,
    private readonly analytics: HarvestAnalyticsRepository,
    private readonly minimumProfit = Number(
      process.env.YIELD_HARVEST_MINIMUM_PROFIT ?? "0",
    ),
    private readonly minimumProfitRatio = Number(
      process.env.YIELD_HARVEST_MINIMUM_PROFIT_RATIO ?? 
        String(DEFAULT_MINIMUM_PROFIT_RATIO),
    ),
    private readonly intervalMs = Number(
      process.env.YIELD_HARVEST_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
    ),
  ) {
    if (!Number.isFinite(minimumProfit) || minimumProfit < 0) {
      throw new Error("Yield harvest minimum profit must be non-negative");
    }
    if (!Number.isFinite(minimumProfitRatio) || minimumProfitRatio < 0) {
      throw new Error("Yield harvest minimum profit ratio must be non-negative");
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("Yield harvest interval must be positive");
    }
  }

  start(): void {
    if (this.timer) return;
    void this.evaluate();
    this.timer = setInterval(() => void this.evaluate(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async evaluate(): Promise<HarvestEvaluation[]> {
    if (this.evaluating) return [];
    this.evaluating = true;

    try {
      const opportunities = await this.source.getOpportunities();
      return await Promise.all(
        opportunities.map((opportunity) =>
          this.evaluateOpportunity(opportunity),
        ),
      );
    } finally {
      this.evaluating = false;
    }
  }

  private async evaluateOpportunity(
    opportunity: YieldOpportunity,
  ): Promise<HarvestEvaluation> {
    this.validateOpportunity(opportunity);
    const evaluatedAt = new Date();
    const netProfit = opportunity.yieldAmount - opportunity.gasCost;
    const profitRatio = opportunity.gasCost > 0 
      ? opportunity.yieldAmount / opportunity.gasCost 
      : Infinity;

    if (netProfit <= this.minimumProfit || profitRatio < this.minimumProfitRatio) {
      await this.analytics.recordHarvest({
        strategyId: opportunity.strategyId,
        asset: opportunity.asset,
        yieldAmount: opportunity.yieldAmount,
        gasCost: opportunity.gasCost,
        netProfit,
        profitRatio,
        minimumProfit: this.minimumProfit,
        minimumProfitRatio: this.minimumProfitRatio,
        status: "SKIPPED",
        evaluatedAt,
      });
      return {
        strategyId: opportunity.strategyId,
        asset: opportunity.asset,
        netProfit,
        status: "SKIPPED",
      };
    }

    try {
      const result = await opportunity.strategy.harvest();
      await this.analytics.recordHarvest({
        strategyId: opportunity.strategyId,
        asset: opportunity.asset,
        yieldAmount: opportunity.yieldAmount,
        gasCost: opportunity.gasCost,
        netProfit,
        profitRatio,
        minimumProfit: this.minimumProfit,
        minimumProfitRatio: this.minimumProfitRatio,
        status: "EXECUTED",
        ...(result.returnAmount === undefined
          ? {}
          : { returnAmount: result.returnAmount }),
        ...(result.transactionHash === undefined
          ? {}
          : { transactionHash: result.transactionHash }),
        evaluatedAt,
        executedAt: new Date(),
      });
      return {
        strategyId: opportunity.strategyId,
        asset: opportunity.asset,
        netProfit,
        status: "EXECUTED",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.analytics.recordHarvest({
        strategyId: opportunity.strategyId,
        asset: opportunity.asset,
        yieldAmount: opportunity.yieldAmount,
        gasCost: opportunity.gasCost,
        netProfit,
        profitRatio,
        minimumProfit: this.minimumProfit,
        minimumProfitRatio: this.minimumProfitRatio,
        status: "FAILED",
        error: message,
        evaluatedAt,
      });
      return {
        strategyId: opportunity.strategyId,
        asset: opportunity.asset,
        netProfit,
        status: "FAILED",
      };
    }
  }

  private validateOpportunity(opportunity: YieldOpportunity): void {
    if (!opportunity.strategyId || !opportunity.asset) {
      throw new Error("Yield opportunity requires strategyId and asset");
    }
    if (
      !Number.isFinite(opportunity.yieldAmount) ||
      !Number.isFinite(opportunity.gasCost) ||
      opportunity.yieldAmount < 0 ||
      opportunity.gasCost < 0
    ) {
      throw new Error(
        "Yield and gas cost must be finite, non-negative numbers",
      );
    }
    if (opportunity.gasCost === 0 && this.minimumProfitRatio > 0) {
      throw new Error(
        "Gas cost cannot be zero when minimum profit ratio is configured",
      );
    }
  }
}
