import test from "node:test";
import assert from "node:assert/strict";
import { stopPlan, priceTargets, createBinanceShadowRunner } from "../research/binance-shadow-runner.mjs";

test("stop planner remains bounded and family-aware",()=>{
  const features={return_5m:-0.0025,realized_vol:0.0015,spread_bps:1};
  const rev=stopPlan(features,"LIQUIDITY_REVERSION_V1");
  const trend=stopPlan(features,"TREND_CONTINUATION_V1");
  assert.ok(rev.stopDistancePct>=0.0025 && rev.stopDistancePct<=0.008);
  assert.ok(trend.stopDistancePct>=0.003 && trend.stopDistancePct<=0.008);
  assert.equal(rev.rewardRisk,1.5);
  assert.equal(trend.rewardRisk,1.8);
});

test("price target math is symmetric for long and short",()=>{
  const long=priceTargets({side:"BUY",entryPrice:100,stopDistancePct:0.01,rewardRisk:2});
  const short=priceTargets({side:"SELL",entryPrice:100,stopDistancePct:0.01,rewardRisk:2});
  assert.equal(long.stopPrice,99);
  assert.equal(long.targetPrice,102);
  assert.equal(short.stopPrice,101);
  assert.equal(short.targetPrice,98);
});

test("shadow runner opens a research trade and closes it at target without live execution",async()=>{
  let solPrice=100;
  const neutralBtc={
    price:100,data_fresh:true,microstructure_quality:true,spread_bps:1,
    return_1m:0,return_5m:0,return_15m:0,realized_vol:0.001,
    cvd_2m:0,cvd_10m:0,orderbook_imbalance:0,
    funding_rate:0,open_interest:1000,open_interest_change:0
  };
  const sol=()=>({
    price:solPrice,data_fresh:true,microstructure_quality:true,spread_bps:1,
    return_1m:0.0001,return_5m:-0.0025,return_15m:-0.0029,realized_vol:0.0015,
    cvd_2m:0.20,cvd_10m:0,orderbook_imbalance:0.20,
    funding_rate:0.0001,open_interest:1000,open_interest_change:0.01
  });
  const bridge={
    features(symbol){ return symbol==="SOLUSDT" ? sol() : neutralBtc; }
  };
  const opened=[];
  const closed=[];
  const lab={
    async openTrial(row){
      const trial={
        trial_id:row.trialId,family:row.family,symbol:row.symbol,side:row.side,
        regime:row.regime,score:row.score,entry_price:row.entryPrice,
        notional_usd:row.notionalUsd,stop_price:row.stopPrice,target_price:row.targetPrice,
        metadata:row.metadata,status:"OPEN"
      };
      opened.push(trial);
      return trial;
    },
    async closeTrial(trial,{exitPrice,exitReason}){
      const row={...trial,status:"CLOSED",exit_price:exitPrice,exit_reason:exitReason,outcome:{netUsd:10,netBps:25}};
      closed.push(row);
      return row;
    },
    async performance(){ return {sampleCount:0,recentSampleCount:0}; }
  };

  const runner=createBinanceShadowRunner({
    symbols:["SOLUSDT"],
    bridge,lab,
    initialEquityUsd:5000,
    peakEquityUsd:5000,
    setRepeater:()=>1,
    clearRepeater:()=>{}
  });

  await runner.tick();
  assert.equal(opened.length,1);
  assert.equal(runner.state().openTrials.length,1);
  assert.equal(opened[0].metadata.research_only,true);
  assert.equal(opened[0].metadata.exchange,"BINANCE");

  solPrice=opened[0].target_price*1.001;
  await runner.tick();
  assert.equal(closed.length,1);
  assert.equal(closed[0].exit_reason,"TARGET");
  assert.equal(runner.state().openTrials.length,0);
  assert.equal(runner.state().equityUsd,5010);
  await runner.tick();
  assert.equal(opened.length,1);
});

test("shadow runner does not open when market quality is stale",async()=>{
  const bridge={features(){return {
    price:100,data_fresh:false,microstructure_quality:false,spread_bps:1,
    return_1m:0.0001,return_5m:-0.0025,return_15m:-0.0029,
    cvd_2m:0.2,cvd_10m:0,orderbook_imbalance:0.2
  };}};
  let opens=0;
  const lab={
    async openTrial(){opens++;},
    async closeTrial(){},
    async performance(){return {};}
  };
  const runner=createBinanceShadowRunner({
    symbols:["SOLUSDT"],bridge,lab,setRepeater:()=>1,clearRepeater:()=>{}
  });
  await runner.tick();
  assert.equal(opens,0);
});


test("shadow runner restores open trials and realized equity after restart",async()=>{
  const bridge={features(symbol){
    return {
      symbol,price:100,data_fresh:false,microstructure_quality:false,spread_bps:1,
      return_1m:0,return_5m:0,return_15m:0,realized_vol:0,
      cvd_2m:0,cvd_10m:0,orderbook_imbalance:0
    };
  }};
  const trial={
    trial_id:"TREND_CONTINUATION_V1:XRPUSDT:1",
    family:"TREND_CONTINUATION_V1",
    symbol:"XRPUSDT",
    side:"BUY",
    opened_at:new Date(Date.now()-60_000).toISOString(),
    entry_price:100,
    stop_price:99,
    target_price:102,
    notional_usd:1000,
    status:"OPEN"
  };
  const lab={
    async loadOpen(){return [trial];},
    async accountingState(){return {equityUsd:5025,peakEquityUsd:5040,realizedNetUsd:25,closedCount:3};},
    async performanceProfile(){return {sampleCount:3,families:{},symbols:{},regimes:{},contexts:{}};},
    async performance(){return {};},
    async openTrial(){throw new Error("should not open");},
    async closeTrial(){throw new Error("should not close");}
  };
  const events=[];
  const runner=createBinanceShadowRunner({
    symbols:["XRPUSDT"],bridge,lab,
    initialEquityUsd:5000,
    setRepeater:()=>1,clearRepeater:()=>{},
    onStatus:e=>events.push(e)
  });
  await runner.start();
  const state=runner.state();
  assert.equal(state.openTrials.length,1);
  assert.equal(state.openTrials[0].trial_id,trial.trial_id);
  assert.equal(state.equityUsd,5025);
  assert.equal(state.peakEquityUsd,5040);
  assert.ok(events.some(e=>e.event==="shadowRecovered" && e.openTrials===1));
  runner.stop();
});
