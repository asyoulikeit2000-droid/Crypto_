import test from "node:test";
import assert from "node:assert/strict";
import { classifyExecutionRegime } from "../strategy/regime-classifier.mjs";
import { evaluateStrategyPromotion } from "../strategy/performance-gate.mjs";
import { routeStrategy } from "../strategy/router.mjs";
import { evaluatePortfolioAdmission } from "../strategy/portfolio-guard.mjs";

const goodQuality = {
  data_fresh: true,
  microstructure_quality: true,
  spread_bps: 1
};

test("regime classifier recognizes flow-confirmed uptrend", () => {
  const r = classifyExecutionRegime({
    ...goodQuality,
    return_1m: 0.0002,
    return_5m: 0.0012,
    return_15m: 0.003,
    realized_vol: 0.002,
    cvd_2m: 0.12,
    cvd_10m: 0.10
  }, { return_5m: 0.0005, return_15m: 0.001 });
  assert.equal(r.regime, "TREND_UP");
});

test("promotion requires statistically credible after-cost edge", () => {
  const pass = evaluateStrategyPromotion({
    sampleCount: 400,
    recentSampleCount: 80,
    avgNetBps: 7,
    recentAvgNetBps: 5,
    netBpsStdDev: 25,
    profitFactor: 1.45,
    foldCount: 5,
    positiveFolds: 4,
    maxDrawdownPct: 0.035,
    costCoverageRatio: 1.3,
    symbolConcentrationPct: 0.45
  });
  assert.equal(pass.promoted, true);

  const fail = evaluateStrategyPromotion({
    sampleCount: 40,
    recentSampleCount: 10,
    avgNetBps: 12,
    recentAvgNetBps: 8,
    netBpsStdDev: 60,
    profitFactor: 1.5,
    foldCount: 5,
    positiveFolds: 3,
    maxDrawdownPct: 0.03,
    costCoverageRatio: 1.2,
    symbolConcentrationPct: 0.4
  });
  assert.equal(fail.promoted, false);
  assert.ok(fail.failed.includes("sampleCount"));
  assert.ok(fail.failed.includes("confidenceBound"));
});

test("router can research a setup before promotion but blocks it for execution", () => {
  const features = {
    ...goodQuality,
    return_1m: 0.0001,
    return_5m: -0.0025,
    return_15m: -0.003,
    realized_vol: 0.002,
    cvd_2m: 0.20,
    cvd_10m: -0.05,
    orderbook_imbalance: 0.20
  };
  const research = routeStrategy({ features, btcFeatures:{}, performance:{}, researchMode:true });
  assert.equal(research.action, "BUY");
  assert.equal(research.selected.family, "LIQUIDITY_REVERSION_V1");
  assert.equal(research.researchOnly, true);

  const execution = routeStrategy({ features, btcFeatures:{}, performance:{}, researchMode:false });
  assert.equal(execution.action, "NO_TRADE");
  assert.equal(execution.reason, "noPromotedStrategy");
});

test("router allows only a promoted strategy outside research mode", () => {
  const features = {
    ...goodQuality,
    symbol:"BTCUSDT",
    return_1m: 0.0002,
    return_5m: 0.0012,
    return_15m: 0.003,
    realized_vol: 0.002,
    cvd_2m: 0.12,
    cvd_10m: 0.10,
    orderbook_imbalance: 0.12
  };
  const stats = {
    sampleCount: 500,
    recentSampleCount: 100,
    avgNetBps: 8,
    recentAvgNetBps: 6,
    netBpsStdDev: 25,
    profitFactor: 1.5,
    foldCount: 5,
    positiveFolds: 4,
    maxDrawdownPct: 0.03,
    costCoverageRatio: 1.4,
    symbolConcentrationPct: 0.4
  };
  const performanceProfile={
    families:{TREND_CONTINUATION_V1:stats},
    symbols:{"TREND_CONTINUATION_V1|BTCUSDT":stats},
    regimes:{"TREND_CONTINUATION_V1|TREND_UP":stats},
    contexts:{"TREND_CONTINUATION_V1|BTCUSDT|TREND_UP":stats}
  };
  const routed = routeStrategy({
    features,
    btcFeatures:{return_5m:0.0005,return_15m:0.001},
    performance:{ TREND_CONTINUATION_V1: stats },
    performanceProfile,
    researchMode:false
  });
  assert.equal(routed.action, "BUY");
  assert.equal(routed.selected.family, "TREND_CONTINUATION_V1");
  assert.equal(routed.researchOnly, false);
});

test("portfolio guard blocks duplicate symbols and directional concentration", () => {
  const r = evaluatePortfolioAdmission(
    { symbol:"SOLUSDT", side:"BUY", notionalUsd:3000 },
    {
      equityUsd:5000,
      positions:[
        {symbol:"BTCUSDT",side:"BUY",notionalUsd:3500},
        {symbol:"SOLUSDT",side:"SELL",notionalUsd:500}
      ]
    },
    {maxOpenPositions:3,maxDirectionalNotionalPct:1.0}
  );
  assert.equal(r.allowed,false);
  assert.ok(r.failed.includes("directionalConcentration"));
  assert.ok(r.failed.includes("duplicateSymbol"));
});
