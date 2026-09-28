import { jest } from "@jest/globals";
import {
  HarvestAnalyticsRecord,
  YieldHarvestDaemon,
  YieldOpportunity,
} from "../src/services/yieldHarvestService.js";

describe("YieldHarvestDaemon", () => {
  function setup(
    opportunity: Partial<YieldOpportunity>,
    minimumProfit = 10,
    minimumProfitRatio = 0,
  ) {
    const harvest = jest.fn().mockResolvedValue({
      returnAmount: 125,
      transactionHash: "tx-1",
    });
    const records: HarvestAnalyticsRecord[] = [];
    const daemon = new YieldHarvestDaemon(
      {
        getOpportunities: async () => [
          {
            strategyId: "strategy-1",
            asset: "USDC",
            yieldAmount: 100,
            gasCost: 20,
            strategy: { harvest },
            ...opportunity,
          },
        ],
      },
      { recordHarvest: async (record) => records.push(record) },
      minimumProfit,
      minimumProfitRatio,
      60_000,
    );
    return { daemon, harvest, records };
  }

  it("harvests and logs the execution return when net profit exceeds the threshold", async () => {
    const { daemon, harvest, records } = setup({
      yieldAmount: 100,
      gasCost: 20,
    });

    await expect(daemon.evaluate()).resolves.toEqual([
      {
        strategyId: "strategy-1",
        asset: "USDC",
        netProfit: 80,
        status: "EXECUTED",
      },
    ]);
    expect(harvest).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({
      netProfit: 80,
      profitRatio: 5,
      minimumProfitRatio: 0,
      status: "EXECUTED",
      returnAmount: 125,
      transactionHash: "tx-1",
    });
  });

  it("does not harvest at or below the minimum threshold", async () => {
    const { daemon, harvest, records } = setup({
      yieldAmount: 30,
      gasCost: 20,
    });

    await daemon.evaluate();

    expect(harvest).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({ 
      netProfit: 10, 
      profitRatio: 1.5,
      minimumProfitRatio: 0,
      status: "SKIPPED" 
    });
  });

  it("logs failed harvests without stopping other evaluations", async () => {
    const firstHarvest = jest
      .fn()
      .mockRejectedValue(new Error("submission failed"));
    const records: HarvestAnalyticsRecord[] = [];
    const daemon = new YieldHarvestDaemon(
      {
        getOpportunities: async () => [
          {
            strategyId: "failed",
            asset: "XLM",
            yieldAmount: 50,
            gasCost: 1,
            strategy: { harvest: firstHarvest },
          },
          {
            strategyId: "skipped",
            asset: "XLM",
            yieldAmount: 2,
            gasCost: 1,
            strategy: { harvest: jest.fn() },
          },
        ],
      },
      { recordHarvest: async (record) => records.push(record) },
      10,
      0,
    );

    await daemon.evaluate();

    expect(records.map((record) => record.status).sort()).toEqual([
      "FAILED",
      "SKIPPED",
    ]);
    expect(records.find((record) => record.status === "FAILED")?.error).toBe(
      "submission failed",
    );
  });

  it("prevents overlapping evaluations", async () => {
    let release: (() => void) | undefined;
    const daemon = new YieldHarvestDaemon(
      {
        getOpportunities: () =>
          new Promise((resolve) => {
            release = () => resolve([]);
          }),
      },
      { recordHarvest: async () => undefined },
      0,
      0,
    );

    const running = daemon.evaluate();
    await expect(daemon.evaluate()).resolves.toEqual([]);
    release?.();
    await expect(running).resolves.toEqual([]);
  });

  it("skips harvest when profit ratio is below threshold", async () => {
    const { daemon, harvest, records } = setup(
      {
        yieldAmount: 50,
        gasCost: 20,
      },
      10,
      3.0,
    );

    await daemon.evaluate();

    expect(harvest).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      netProfit: 30,
      profitRatio: 2.5,
      status: "SKIPPED",
    });
  });

  it("executes harvest when profit ratio meets threshold", async () => {
    const { daemon, harvest, records } = setup(
      {
        yieldAmount: 60,
        gasCost: 20,
      },
      10,
      3.0,
    );

    await daemon.evaluate();

    expect(harvest).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({
      netProfit: 40,
      profitRatio: 3.0,
      status: "EXECUTED",
    });
  });

  it("skips harvest when both profit and ratio thresholds are not met", async () => {
    const { daemon, harvest, records } = setup(
      {
        yieldAmount: 25,
        gasCost: 20,
      },
      10,
      3.0,
    );

    await daemon.evaluate();

    expect(harvest).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      netProfit: 5,
      profitRatio: 1.25,
      status: "SKIPPED",
    });
  });

  it("handles zero gas cost when profit ratio threshold is disabled", async () => {
    const { daemon, harvest, records } = setup(
      {
        yieldAmount: 100,
        gasCost: 0,
      },
      10,
      0,
    );

    await daemon.evaluate();

    expect(harvest).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({
      netProfit: 100,
      profitRatio: Infinity,
      status: "EXECUTED",
    });
  });

  it("throws error when gas cost is zero with positive profit ratio threshold", async () => {
    const daemon = new YieldHarvestDaemon(
      {
        getOpportunities: async () => [
          {
            strategyId: "strategy-1",
            asset: "USDC",
            yieldAmount: 100,
            gasCost: 0,
            strategy: { harvest: jest.fn() },
          },
        ],
      },
      { recordHarvest: async () => undefined },
      10,
      3.0,
    );

    await expect(daemon.evaluate()).rejects.toThrow(
      "Gas cost cannot be zero when minimum profit ratio is configured",
    );
  });
});
