import test from "node:test";
import assert from "node:assert/strict";
import { loadExecutionConfig } from "../execution/config.mjs";
import { prepareEconomicIntent } from "../execution/economics.mjs";
import { createShadowBroker } from "../execution/shadow-broker.mjs";

const costs = {
  entryFeeRate: 0.0002,
  exitFeeRate: 0.0005,
  entrySlippageBps: 0.5,
  exitSlippageBps: 1,
  spreadCrossingBps: 0.5,
  fundingRateAbs: 0.0001,
  expectedFundingPeriods: 1
};

test("economic intent derives net PnL instead of trusting supplied net", () => {
  const result = prepareEconomicIntent({
    requestedNotionalUsd: 5000,
    expectedGrossUsd: 9,
    expectedNetUsd: 999
  }, costs);
  assert.equal(Number(result.expectedNetUsd.toFixed(2)), 4.00);
});

test("shadow broker rejects spoofed net when centrally computed net is below gate", async () => {
  const config = loadExecutionConfig({
    EXECUTION_MODE: "paper",
    EXECUTION_EXCHANGE: "BINANCE",
    MIN_EXPECTED_NET_USD: "6.5",
    MAX_POSITION_NOTIONAL_USD: "5000",
    MAX_EFFECTIVE_LEVERAGE: "3"
  });
  const broker = createShadowBroker({ config, costAssumptions: costs });
  const result = await broker.submit({
    intent: {
      symbol: "BTCUSDT",
      side: "BUY",
      requestedNotionalUsd: 5000,
      effectiveLeverage: 2,
      expectedGrossUsd: 9,
      expectedNetUsd: 999,
      maxLossAtStopUsd: 80,
      rewardRisk: 1.5
    },
    account: {
      equityUsd: 50_000,
      peakEquityUsd: 50_000,
      freeMarginUsd: 20_000,
      dailyPnlUsd: 0,
      openPositions: 0,
      killSwitch: false,
      exchangeHealthy: true
    },
    market: {
      exchange: "BINANCE",
      bookExchange: "BINANCE",
      bookFresh: true,
      marketDataAgeMs: 100,
      spreadBps: 1
    }
  });
  assert.equal(result.accepted, false);
  assert.ok(result.failed.includes("expectedNetTooLow"));
  assert.equal(Number(result.economics.expectedNetUsd.toFixed(2)), 4.00);
});
