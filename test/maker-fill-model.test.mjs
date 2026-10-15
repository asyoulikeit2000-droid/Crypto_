import test from "node:test";
import assert from "node:assert/strict";
import { buildMakerOrder, evaluateMakerFill } from "../research/maker-fill-model.mjs";

test("buy maker order only fills after plausible sell flow consumes its queue",()=>{
  const order=buildMakerOrder({
    family:"TREND_CONTINUATION_V1",symbol:"BTCUSDT",side:"BUY",regime:"TREND_UP",score:80,
    features:{price:100.05,best_bid:100,best_ask:100.1,best_bid_qty:2,spread_bps:10},
    notionalUsd:100,submittedAt:1000,ttlMs:30000,queueAheadFraction:0.5
  });
  assert.equal(order.valid,true);
  assert.equal(order.orderQty,1);
  const early=evaluateMakerFill(order,[
    {t:2000,price:100,qty:0.5,side:"SELL"},
    {t:3000,price:100,qty:0.7,side:"SELL"}
  ],4000);
  assert.equal(early.status,"PENDING");
  const filled=evaluateMakerFill(order,[
    {t:2000,price:100,qty:1.1,side:"SELL"},
    {t:3000,price:100,qty:0.9,side:"SELL"}
  ],4000);
  assert.equal(filled.status,"FILLED");
  assert.equal(filled.fillPrice,100);
});

test("trade through the limit implies a maker fill even if observed at-limit queue volume is incomplete",()=>{
  const order=buildMakerOrder({
    family:"LIQUIDITY_REVERSION_V1",symbol:"SOLUSDT",side:"SELL",regime:"RANGE",score:82,
    features:{price:50,best_bid:49.99,best_ask:50.01,best_ask_qty:100},
    notionalUsd:500,submittedAt:1000,ttlMs:30000,queueAheadFraction:1
  });
  const filled=evaluateMakerFill(order,[
    {t:2500,price:50.02,qty:0.1,side:"BUY"}
  ],3000);
  assert.equal(filled.status,"FILLED");
  assert.equal(filled.reason,"tradedThroughLimit");
});

test("unfilled maker order expires instead of becoming a fake trade",()=>{
  const order=buildMakerOrder({
    family:"TREND_CONTINUATION_V1",symbol:"ETHUSDT",side:"BUY",regime:"TREND_UP",score:80,
    features:{price:100,best_bid:99.9,best_ask:100.1,best_bid_qty:5},
    notionalUsd:1000,submittedAt:1000,ttlMs:5000
  });
  const r=evaluateMakerFill(order,[],7000);
  assert.equal(r.status,"EXPIRED");
  assert.equal(r.filled,false);
});
