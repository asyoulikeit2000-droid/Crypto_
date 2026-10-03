import test from "node:test";
import assert from "node:assert/strict";
import { executableExitPrice, fundingCostUsd } from "../research/exit-accounting.mjs";

test("long exits at bid and short exits at ask",()=>{
  const f={price:100,best_bid:99.9,best_ask:100.1};
  assert.equal(executableExitPrice(f,"BUY"),99.9);
  assert.equal(executableExitPrice(f,"SELL"),100.1);
});

test("positive funding is a cost to longs and credit to shorts",()=>{
  const common={
    notionalUsd:5000,
    openedAtMs:1000,
    closedAtMs:9000,
    events:[{t:5000,rate:0.0001}]
  };
  assert.equal(fundingCostUsd({...common,side:"BUY"}),0.5);
  assert.equal(fundingCostUsd({...common,side:"SELL"}),-0.5);
});

test("entry funding metadata is a restart-safe fallback when one funding time is crossed",()=>{
  const cost=fundingCostUsd({
    side:"BUY",notionalUsd:2000,openedAtMs:1000,closedAtMs:6000,
    events:[],fallbackRate:0.0002,fallbackFundingTime:5000
  });
  assert.equal(cost,0.4);
});

test("funding outside the holding interval is ignored",()=>{
  const cost=fundingCostUsd({
    side:"BUY",notionalUsd:2000,openedAtMs:1000,closedAtMs:4000,
    events:[{t:5000,rate:0.001}],fallbackRate:0.001,fallbackFundingTime:5000
  });
  assert.equal(cost,0);
});
