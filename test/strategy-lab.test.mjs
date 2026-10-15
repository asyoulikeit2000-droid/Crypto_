import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTradeOutcome } from "../research/outcome-accounting.mjs";
import { createStrategyLab } from "../research/strategy-lab.mjs";

test("trade outcome subtracts actual fees slippage and funding",()=>{
  const r=evaluateTradeOutcome({
    side:"BUY",
    entryPrice:100,
    exitPrice:100.5,
    notionalUsd:4000,
    actualFeesUsd:2,
    actualSlippageUsd:1,
    actualFundingUsd:0.5
  });
  assert.equal(r.valid,true);
  assert.equal(Number(r.grossUsd.toFixed(2)),20);
  assert.equal(Number(r.netUsd.toFixed(2)),16.5);
  assert.equal(Number(r.netBps.toFixed(2)),41.25);
});

test("short outcome uses inverse price direction",()=>{
  const r=evaluateTradeOutcome({
    side:"SELL",
    entryPrice:100,
    exitPrice:99,
    notionalUsd:1000,
    actualFeesUsd:0,
    actualSlippageUsd:0,
    actualFundingUsd:0
  });
  assert.equal(Number(r.grossUsd.toFixed(2)),10);
  assert.equal(Number(r.netUsd.toFixed(2)),10);
});

test("strategy lab persists immutable-style open and closed research trials",async()=>{
  const rows=new Map();
  async function db(table,method,params,body){
    assert.equal(table,"strategy_trials");
    if(method==="POST"){
      const key=body.trial_id;
      const prev=rows.get(key)||{};
      rows.set(key,{...prev,...body});
      return [];
    }
    if(method==="GET"){
      return [...rows.values()]
        .filter(x=>x.status==="CLOSED")
        .filter(x=>!params.family || x.family===params.family.slice(3));
    }
    throw new Error("unsupported");
  }

  const lab=createStrategyLab({
    db,
    costAssumptions:{
      entryFeeRate:0.0002,
      exitFeeRate:0.0005,
      entrySlippageBps:0,
      exitSlippageBps:0,
      spreadCrossingBps:0,
      fundingRateAbs:0,
      expectedFundingPeriods:0
    }
  });

  const trial=await lab.openTrial({
    trialId:"t1",
    family:"LIQUIDITY_REVERSION_V1",
    symbol:"BTCUSDT",
    side:"BUY",
    regime:"RANGE",
    score:82,
    entryPrice:100,
    notionalUsd:4000,
    stopPrice:99.5,
    targetPrice:101
  });
  assert.equal(trial.status,"OPEN");

  const closed=await lab.closeTrial(trial,{
    exitPrice:100.5,
    actualFeesUsd:2,
    actualSlippageUsd:1,
    actualFundingUsd:0
  });
  assert.equal(closed.status,"CLOSED");
  assert.ok(closed.outcome.netUsd>0);

  const perf=await lab.performance({family:"LIQUIDITY_REVERSION_V1"});
  assert.equal(perf.sampleCount,1);
});
