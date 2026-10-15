import test from "node:test";
import assert from "node:assert/strict";
import { targetMakerFill, resolveExitTrigger, walkMarketExit, actualExitFeesUsd } from "../research/exit-fill-model.mjs";

test("long maker target requires an aggressive buy trade through the target",()=>{
  const no=targetMakerFill({
    positionSide:"BUY",targetPrice:101,sinceMs:0,untilMs:10000,
    trades:[{t:5000,price:101,qty:2,side:"BUY"}]
  });
  assert.equal(no.filled,false);

  const yes=targetMakerFill({
    positionSide:"BUY",targetPrice:101,sinceMs:0,untilMs:10000,
    trades:[{t:5000,price:101.01,qty:0.1,side:"BUY"}]
  });
  assert.equal(yes.filled,true);
  assert.equal(yes.exitPrice,101);
  assert.equal(yes.exitLiquidity,"MAKER");
});

test("short maker target requires an aggressive sell through target",()=>{
  const yes=targetMakerFill({
    positionSide:"SELL",targetPrice:99,sinceMs:0,untilMs:10000,
    trades:[{t:4000,price:98.99,qty:1,side:"SELL"}]
  });
  assert.equal(yes.filled,true);
  assert.equal(yes.exitPrice,99);
});

test("taker close walks the visible book by position quantity",()=>{
  const r=walkMarketExit({
    positionSide:"BUY",
    positionQty:3,
    book:{bids:[[100,1],[99.9,2],[99.8,10]]}
  });
  assert.equal(r.valid,true);
  assert.equal(r.fullyVisible,true);
  assert.equal(Number(r.exitPrice.toFixed(6)),Number(((100+99.9*2)/3).toFixed(6)));
  assert.ok(r.impactBps>0);
});

test("insufficient visible depth uses a conservative adverse penalty",()=>{
  const r=walkMarketExit({
    positionSide:"SELL",
    positionQty:5,
    book:{asks:[[100,1],[100.1,1]]},
    missingDepthPenaltyBps:10
  });
  assert.equal(r.valid,true);
  assert.equal(r.fullyVisible,false);
  assert.equal(r.syntheticFilledQty,3);
  assert.ok(r.exitPrice>100.1);
});

test("fees distinguish maker target from taker stop",()=>{
  const makerExit=actualExitFeesUsd({
    entryNotionalUsd:4000,exitNotionalUsd:4040,
    entryLiquidity:"MAKER",exitLiquidity:"MAKER",
    makerFeeRate:0.0002,takerFeeRate:0.0005
  });
  const takerExit=actualExitFeesUsd({
    entryNotionalUsd:4000,exitNotionalUsd:3960,
    entryLiquidity:"MAKER",exitLiquidity:"TAKER",
    makerFeeRate:0.0002,takerFeeRate:0.0005
  });
  assert.ok(takerExit>makerExit*0.9);
  assert.equal(Number(makerExit.toFixed(4)),1.608);
  assert.equal(Number(takerExit.toFixed(4)),2.78);
});


test("exit trigger follows observed trade sequence instead of checking barriers out of order",()=>{
  const r=resolveExitTrigger({
    positionSide:"BUY",
    stopPrice:99,
    targetPrice:101,
    sinceMs:0,
    untilMs:10000,
    trades:[
      {t:3000,price:101.02,qty:1,side:"BUY"},
      {t:5000,price:98.9,qty:1,side:"SELL"}
    ],
    bestBid:98.9,
    expired:false
  });
  assert.equal(r.triggered,true);
  assert.equal(r.exitReason,"TARGET");
  assert.equal(r.exitLiquidity,"MAKER");
  assert.equal(r.at,3000);
});

test("book crossing can trigger a stop when no trade event was retained",()=>{
  const r=resolveExitTrigger({
    positionSide:"SELL",
    stopPrice:101,
    targetPrice:98,
    trades:[],
    bestAsk:101.2,
    untilMs:5000
  });
  assert.equal(r.triggered,true);
  assert.equal(r.exitReason,"STOP");
  assert.equal(r.exitLiquidity,"TAKER");
});
