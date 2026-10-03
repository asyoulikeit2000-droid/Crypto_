import test from "node:test";
import assert from "node:assert/strict";
import {
  publicStreams,marketStreams,combinedUrl,
  normalizeAggTrade,normalizeDepth,normalizeMarkPrice,
  createBinanceUsdmFeed
} from "../market/binance-usdm-feed.mjs";

test("Binance stream plan uses split public and market endpoints",()=>{
  const p=publicStreams(["BTCUSDT"]);
  const m=marketStreams(["BTCUSDT"]);
  assert.deepEqual(p,["btcusdt@depth20@100ms","btcusdt@bookTicker"]);
  assert.deepEqual(m,["btcusdt@aggTrade","btcusdt@markPrice@1s"]);
  assert.match(combinedUrl("wss://fstream.binance.com/public/stream?streams=",p),/\/public\/stream\?streams=/);
});

test("aggregate trade direction follows taker side",()=>{
  const buy=normalizeAggTrade({e:"aggTrade",s:"BTCUSDT",p:"100",q:"2",T:1,m:false});
  const sell=normalizeAggTrade({e:"aggTrade",s:"BTCUSDT",p:"100",q:"2",T:1,m:true});
  assert.equal(buy.side,"BUY");
  assert.equal(sell.side,"SELL");
});

test("depth computes notional imbalance and spread",()=>{
  const d=normalizeDepth({
    s:"BTCUSDT",E:123,
    b:[["100","2"],["99","1"]],
    a:[["101","1"],["102","1"]]
  });
  assert.equal(d.symbol,"BTCUSDT");
  assert.ok(d.bidDepthUsd>d.askDepthUsd);
  assert.ok(d.imbalance>0);
  assert.ok(d.spreadBps>0);
});

test("mark price keeps funding context",()=>{
  const m=normalizeMarkPrice({s:"BTCUSDT",E:10,p:"100.5",i:"100.4",r:"0.0001",T:99,ap:"100.45"});
  assert.equal(m.fundingRate,0.0001);
  assert.equal(m.nextFundingTime,99);
});

test("feed builds current Binance split websocket URLs without requiring API credentials",()=>{
  class FakeWebSocket {
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=1;this.handlers={};}
    addEventListener(name,fn){this.handlers[name]=fn;}
    close(){}
  }
  const feed=createBinanceUsdmFeed({
    symbols:["BTCUSDT","SOLUSDT"],
    WebSocketImpl:FakeWebSocket,
    fetchImpl:async()=>({ok:true,json:async()=>({openInterest:"1",time:1})}),
    setTimer:()=>1,clearTimer:()=>{},setRepeater:()=>1,clearRepeater:()=>{}
  });
  assert.match(feed.urls.public,/\/public\/stream\?streams=/);
  assert.match(feed.urls.market,/\/market\/stream\?streams=/);
  assert.ok(feed.urls.public.includes("btcusdt@depth20@100ms"));
  assert.ok(feed.urls.market.includes("solusdt@aggTrade"));
  assert.ok(feed.urls.market.includes("solusdt@markPrice@1s"));
  assert.equal(feed.urls.public.includes("%40"),false);
});
