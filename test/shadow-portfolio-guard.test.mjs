import test from "node:test";
import assert from "node:assert/strict";
import { summarizeShadowExposure, evaluateShadowAdmission } from "../research/shadow-portfolio-guard.mjs";

test("pending maker orders reserve capital and position slots",()=>{
  const exposure=summarizeShadowExposure({
    equityUsd:5000,
    openTrials:[{
      symbol:"XRPUSDT",side:"BUY",notional_usd:2400,metadata:{risk_usd:7}
    }],
    pending:[{
      order:{symbol:"SOLUSDT",side:"SELL",notionalUsd:1800},
      attempt:{metadata:{risk_usd:8}}
    }]
  });
  assert.equal(exposure.reservedSlots,2);
  assert.equal(exposure.totalNotionalUsd,4200);
  assert.equal(exposure.aggregateRiskUsd,15);

  const r=evaluateShadowAdmission(
    {symbol:"ETHUSDT",side:"BUY",notionalUsd:1000,riskUsd:5},
    exposure,
    {maxConcurrentPositions:2}
  );
  assert.equal(r.allowed,false);
  assert.ok(r.failed.includes("maxConcurrentPositions"));
});

test("directional exposure and aggregate stop risk are bounded",()=>{
  const exposure=summarizeShadowExposure({
    equityUsd:5000,
    openTrials:[{symbol:"BTCUSDT",side:"BUY",notional_usd:4500,metadata:{risk_usd:12}}],
    pending:[]
  });
  const r=evaluateShadowAdmission(
    {symbol:"ETHUSDT",side:"BUY",notionalUsd:2500,riskUsd:10},
    exposure,
    {maxConcurrentPositions:3,maxTotalNotionalPct:2,maxDirectionalNotionalPct:1.25,maxAggregateRiskPct:0.004}
  );
  assert.equal(r.allowed,false);
  assert.ok(r.failed.includes("directionalNotional"));
  assert.ok(r.failed.includes("aggregateRisk"));
});

test("small independent second position can be admitted",()=>{
  const exposure=summarizeShadowExposure({
    equityUsd:5000,
    openTrials:[{symbol:"BTCUSDT",side:"BUY",notional_usd:2500,metadata:{risk_usd:8}}],
    pending:[]
  });
  const r=evaluateShadowAdmission(
    {symbol:"SOLUSDT",side:"SELL",notionalUsd:1800,riskUsd:7},
    exposure,
    {}
  );
  assert.equal(r.allowed,true);
  assert.equal(r.projected.reservedSlots,2);
});
