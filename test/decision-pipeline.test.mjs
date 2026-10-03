import test from "node:test";
import assert from "node:assert/strict";
import { loadExecutionConfig } from "../execution/config.mjs";
import { buildTradeDecision } from "../execution/decision-pipeline.mjs";

const config=loadExecutionConfig({
  EXECUTION_MODE:"paper",
  EXECUTION_EXCHANGE:"BINANCE",
  MAX_POSITION_NOTIONAL_USD:"5000",
  MAX_EFFECTIVE_LEVERAGE:"3",
  MIN_EXPECTED_NET_USD:"6.5",
  MIN_EXPECTED_NET_EQUITY_PCT:"0.001",
  MAX_OPEN_POSITIONS:"2"
});

const account={
  equityUsd:5000,
  peakEquityUsd:5000,
  freeMarginUsd:5000,
  dailyPnlUsd:0,
  openPositions:0,
  killSwitch:false,
  exchangeHealthy:true
};

const market={
  exchange:"BINANCE",
  bookExchange:"BINANCE",
  bookFresh:true,
  marketDataAgeMs:100,
  spreadBps:1
};

const features={
  data_fresh:true,
  microstructure_quality:true,
  spread_bps:1,
  return_1m:0.0002,
  return_5m:0.0012,
  return_15m:0.003,
  realized_vol:0.002,
  cvd_2m:0.12,
  cvd_10m:0.10,
  orderbook_imbalance:0.12
};

const promotedStats={
  sampleCount:500,
  recentSampleCount:100,
  avgNetBps:40,
  recentAvgNetBps:34,
  netBpsStdDev:20,
  profitFactor:2.0,
  foldCount:5,
  positiveFolds:4,
  maxDrawdownPct:0.03,
  costCoverageRatio:1.4,
  symbolConcentrationPct:0.4
};

function profileFor(symbol){
  return {
    families:{TREND_CONTINUATION_V1:promotedStats},
    symbols:{[`TREND_CONTINUATION_V1|${symbol}`]:promotedStats},
    regimes:{"TREND_CONTINUATION_V1|TREND_UP":promotedStats},
    contexts:{[`TREND_CONTINUATION_V1|${symbol}|TREND_UP`]:promotedStats}
  };
}

const costs={
  entryFeeRate:0.0002,
  exitFeeRate:0.0005,
  entrySlippageBps:0.5,
  exitSlippageBps:1,
  spreadCrossingBps:0.5,
  fundingRateAbs:0,
  expectedFundingPeriods:0
};

test("pipeline approves only when every strategy economics portfolio and risk gate passes",()=>{
  const r=buildTradeDecision({
    symbol:"BTCUSDT",
    features,
    btcFeatures:{return_5m:0.0005,return_15m:0.001},
    performance:{TREND_CONTINUATION_V1:promotedStats},
    performanceProfile:profileFor("BTCUSDT"),
    account,
    portfolio:{positions:[]},
    market,
    config,
    costAssumptions:costs,
    stopDistancePct:0.0025,
    researchMode:false
  });
  assert.equal(r.allowed,true);
  assert.equal(r.stage,"approved");
  assert.equal(r.intent.strategyFamily,"TREND_CONTINUATION_V1");
  assert.equal(r.intent.effectiveLeverage,2);
  assert.ok(r.intent.notionalToEquity<=1);
  assert.ok(r.intent.expectedNetUsd>=6.5);
});

test("pipeline blocks a strategy with no proven performance",()=>{
  const r=buildTradeDecision({
    symbol:"BTCUSDT",
    features,
    btcFeatures:{return_5m:0.0005,return_15m:0.001},
    performance:{},
    performanceProfile:{},
    account,
    portfolio:{positions:[]},
    market,
    config,
    costAssumptions:costs,
    stopDistancePct:0.0025,
    researchMode:false
  });
  assert.equal(r.allowed,false);
  assert.equal(r.stage,"strategy");
});

test("pipeline blocks mismatched execution venue",()=>{
  const r=buildTradeDecision({
    symbol:"BTCUSDT",
    features,
    btcFeatures:{return_5m:0.0005,return_15m:0.001},
    performance:{TREND_CONTINUATION_V1:promotedStats},
    performanceProfile:profileFor("BTCUSDT"),
    account,
    portfolio:{positions:[]},
    market:{...market,exchange:"BYBIT",bookExchange:"BYBIT"},
    config,
    costAssumptions:costs,
    stopDistancePct:0.0025,
    researchMode:false
  });
  assert.equal(r.allowed,false);
  assert.equal(r.stage,"venue");
});

test("pipeline blocks same-direction concentration",()=>{
  const r=buildTradeDecision({
    symbol:"ETHUSDT",
    features,
    btcFeatures:{return_5m:0.0005,return_15m:0.001},
    performance:{TREND_CONTINUATION_V1:promotedStats},
    performanceProfile:profileFor("ETHUSDT"),
    account:{...account,openPositions:1},
    portfolio:{positions:[{symbol:"BTCUSDT",side:"BUY",notionalUsd:4500}]},
    market,
    config,
    costAssumptions:costs,
    stopDistancePct:0.0025,
    researchMode:false,
    policy:{maxDirectionalNotionalPct:1.25}
  });
  assert.equal(r.allowed,false);
  assert.equal(r.stage,"portfolio");
});
