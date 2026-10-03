import test from "node:test";
import assert from "node:assert/strict";
import { estimateRoundTripCosts, estimateExpectedNetPnl, minimumGrossUsdForNetTarget } from "../execution/cost-model.mjs";

test("cost model includes fees, slippage, spread and funding reserve", () => {
  const r = estimateRoundTripCosts({
    notionalUsd: 5000,
    entryFeeRate: 0.0002,
    exitFeeRate: 0.0005,
    entrySlippageBps: 0.5,
    exitSlippageBps: 1.0,
    spreadCrossingBps: 0.5,
    fundingRateAbs: 0.0001,
    expectedFundingPeriods: 1
  });
  assert.equal(Number(r.feesUsd.toFixed(2)), 3.50);
  assert.equal(Number(r.slippageUsd.toFixed(2)), 0.75);
  assert.equal(Number(r.spreadUsd.toFixed(2)), 0.25);
  assert.equal(Number(r.fundingReserveUsd.toFixed(2)), 0.50);
  assert.equal(Number(r.totalCostsUsd.toFixed(2)), 5.00);
});

test("expected net is calculated after every modeled cost", () => {
  const r = estimateExpectedNetPnl({
    expectedGrossUsd: 13,
    notionalUsd: 5000,
    entryFeeRate: 0.0002,
    exitFeeRate: 0.0005,
    entrySlippageBps: 0.5,
    exitSlippageBps: 1.0,
    spreadCrossingBps: 0.5,
    fundingRateAbs: 0.0001,
    expectedFundingPeriods: 1
  });
  assert.equal(Number(r.expectedNetUsd.toFixed(2)), 8.00);
});

test("gross requirement for a $5 target rises with trading costs", () => {
  const r = minimumGrossUsdForNetTarget({
    targetNetUsd: 5,
    notionalUsd: 5000,
    entryFeeRate: 0.0002,
    exitFeeRate: 0.0005,
    entrySlippageBps: 0.5,
    exitSlippageBps: 1.0,
    spreadCrossingBps: 0.5,
    fundingRateAbs: 0.0001,
    expectedFundingPeriods: 1
  });
  assert.equal(Number(r.requiredGrossUsd.toFixed(2)), 10.00);
});
