import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePreRally } from "../scanner/scoring.mjs";

test("strong DEX-only evidence stays research-only because confidence is capped",()=>{
  const r=evaluatePreRally({
    liquidityUsd:500000,marketCap:5000000,fdv:6000000,volume24h:1500000,volume6h:500000,
    buys1h:180,sells1h:100,buys24h:1600,sells24h:1200,priceChange1h:3,priceChange6h:8,priceChange24h:5,
    pairAgeHours:240,sourceAgeSec:10,providerCount:1
  });
  assert.ok(r.preRallyScore>=70);
  assert.ok(r.confidenceScore<=65);
  assert.notEqual(r.classification,"high_priority_watch");
  assert.ok(r.positiveSignals.length>=3);
});

test("low liquidity becomes a critical risk and blocks promotion",()=>{
  const r=evaluatePreRally({
    liquidityUsd:12000,marketCap:3000000,fdv:3000000,volume24h:900000,volume6h:300000,
    buys1h:200,sells1h:80,buys24h:1000,sells24h:700,priceChange1h:2,priceChange6h:4,priceChange24h:1,
    pairAgeHours:100,sourceAgeSec:10,providerCount:1
  });
  assert.ok(r.criticalFlags.includes("LOW_LIQUIDITY"));
  assert.equal(r.classification,"avoid");
});

test("missing fields reduce data coverage and confidence",()=>{
  const r=evaluatePreRally({liquidityUsd:100000,volume24h:50000,sourceAgeSec:10,providerCount:1});
  assert.ok(r.dataCoverageScore<40);
  assert.equal(r.classification,"insufficient_data");
  assert.ok(r.missingData.length>0);
});

test("stale provider data lowers confidence and emits warning",()=>{
  const fresh=evaluatePreRally({
    liquidityUsd:300000,marketCap:5000000,fdv:5500000,volume24h:500000,volume6h:150000,
    buys1h:100,sells1h:80,buys24h:900,sells24h:800,priceChange1h:1,priceChange6h:2,priceChange24h:3,
    pairAgeHours:100,sourceAgeSec:30,providerCount:2
  });
  const stale=evaluatePreRally({
    liquidityUsd:300000,marketCap:5000000,fdv:5500000,volume24h:500000,volume6h:150000,
    buys1h:100,sells1h:80,buys24h:900,sells24h:800,priceChange1h:1,priceChange6h:2,priceChange24h:3,
    pairAgeHours:100,sourceAgeSec:1000,providerCount:2
  });
  assert.ok(stale.confidenceScore<fresh.confidenceScore);
  assert.ok(stale.warningFlags.includes("STALE_OR_UNKNOWN_SOURCE_TIME"));
});
