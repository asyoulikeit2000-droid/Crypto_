import test from "node:test";
import assert from "node:assert/strict";
import { sizePosition } from "../strategy/equity-risk.mjs";
import { evaluateLiquidityReversion } from "../strategy/liquidity-reversion-v1.mjs";

test("5000 USDT sizing uses stop-defined risk rather than leverage target", () => {
  const sized = sizePosition({
    equityUsd: 5000,
    peakEquityUsd: 5000,
    stopDistancePct: 0.0025,
    score: 100,
    baseRiskPct: 0.002,
    maxNotionalEquityMultiple: 1,
    maxNotionalUsd: 5000
  });
  assert.equal(Number(sized.riskUsd.toFixed(2)), 10);
  assert.equal(Number(sized.notionalUsd.toFixed(2)), 4000);
  assert.equal(Number(sized.effectiveNotionalToEquity.toFixed(2)), 0.8);
});

test("position risk automatically shrinks during drawdown", () => {
  const sized = sizePosition({
    equityUsd: 4800,
    peakEquityUsd: 5000,
    stopDistancePct: 0.0025,
    score: 100
  });
  assert.equal(Number(sized.ddMultiplier.toFixed(2)), 0.5);
  assert.equal(Number(sized.riskUsd.toFixed(2)), 4.8);
});

test("five percent drawdown stops new position sizing", () => {
  const sized = sizePosition({
    equityUsd: 4750,
    peakEquityUsd: 5000,
    stopDistancePct: 0.0025,
    score: 100
  });
  assert.equal(sized.allowed, false);
  assert.equal(sized.reason, "drawdownStop");
});

test("liquidity reversion requires impulse plus actual flow/book reversal", () => {
  const setup = evaluateLiquidityReversion({
    return_1m: 0.0001,
    return_5m: -0.0025,
    return_15m: -0.003,
    cvd_2m: 0.20,
    cvd_10m: -0.05,
    orderbook_imbalance: 0.20,
    spread_bps: 1.2,
    microstructure_quality: true,
    data_fresh: true
  }, { regime: "RANGE", maxSpreadBps: 4 });
  assert.equal(setup.action, "BUY");
  assert.ok(setup.score >= 70);
});

test("liquidity reversion refuses to fade a strong directional trend", () => {
  const setup = evaluateLiquidityReversion({
    return_1m: 0.0001,
    return_5m: -0.0025,
    return_15m: -0.003,
    cvd_2m: 0.20,
    cvd_10m: -0.05,
    orderbook_imbalance: 0.20,
    spread_bps: 1.2,
    microstructure_quality: true,
    data_fresh: true
  }, { regime: "TREND_DOWN", maxSpreadBps: 4 });
  assert.equal(setup.action, "NO_TRADE");
});
