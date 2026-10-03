import test from "node:test";
import assert from "node:assert/strict";
import { createIntelligenceEngine } from "../intelligence-engine.mjs";
import { createBinanceFeatureBridge } from "../market/binance-feature-bridge.mjs";

test("Binance bridge produces same-venue features with funding and OI",()=>{
  const intelligence=createIntelligenceEngine();
  const b=createBinanceFeatureBridge({intelligence});
  const now=Date.now();
  b.onBook({
    type:"depth",symbol:"BTCUSDT",t:now,
    imbalance:0.2,spreadBps:1,depthUsd:1_000_000,bidDepthUsd:600_000,askDepthUsd:400_000
  });
  for(let i=0;i<6;i++) b.onTrade({
    symbol:"BTCUSDT",t:now-5000+i*900,price:100+i*0.01,qty:1,side:"BUY"
  });
  b.onMark({symbol:"BTCUSDT",markPrice:100.1,fundingRate:0.0001,nextFundingTime:now+3600000});
  b.onOpenInterest({symbol:"BTCUSDT",t:now-30000,openInterest:1000});
  b.onOpenInterest({symbol:"BTCUSDT",t:now,openInterest:1010});
  const f=b.features("BTCUSDT");
  assert.equal(f.exchange,"BINANCE");
  assert.equal(f.funding_rate,0.0001);
  assert.equal(f.open_interest,1010);
  assert.equal(Number(f.open_interest_change.toFixed(3)),0.01);
  assert.equal(f.data_fresh,true);
});


test("Binance bridge records a funding event when next funding time rolls forward",()=>{
  const intelligence=createIntelligenceEngine();
  const b=createBinanceFeatureBridge({intelligence});
  const base=1_700_000_000_000;
  b.onMark({
    symbol:"BTCUSDT",t:base,
    markPrice:100,fundingRate:0.0001,nextFundingTime:base+10_000
  });
  b.onMark({
    symbol:"BTCUSDT",t:base+10_100,
    markPrice:100.1,fundingRate:0.0002,nextFundingTime:base+8*60*60*1000
  });
  const events=b.fundingEventsSince("BTCUSDT",base,base+20_000);
  assert.equal(events.length,1);
  assert.equal(events[0].t,base+10_000);
  assert.equal(events[0].rate,0.0001);
});
