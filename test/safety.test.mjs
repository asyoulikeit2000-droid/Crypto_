import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSignalReadiness } from "../signal-gates.mjs";
import { isEligibleInstrument, rankEligibleUniverse } from "../universe-engine.mjs";
import { createIntelligenceEngine } from "../intelligence-engine.mjs";

test("signal gate requires every production condition", () => {
  const good = evaluateSignalReadiness(
    { status: "ACTIVE" },
    { status: "COMPLETE", evaluatedAt: "2026-10-01T00:00:00Z", test: { n: 20, winRate: 0.4, avgPnl: 0.01, totalPnl: 0.2 } }
  );
  assert.equal(good.ready, true);
  for (const mutation of [
    [{status:"WARMING"}, {status:"COMPLETE",test:{n:20,avgPnl:.01,totalPnl:.2}}],
    [{status:"ACTIVE"}, {status:"RUNNING",test:{n:20,avgPnl:.01,totalPnl:.2}}],
    [{status:"ACTIVE"}, {status:"COMPLETE",test:{n:19,avgPnl:.01,totalPnl:.2}}],
    [{status:"ACTIVE"}, {status:"COMPLETE",test:{n:20,avgPnl:0,totalPnl:.2}}],
    [{status:"ACTIVE"}, {status:"COMPLETE",test:{n:20,avgPnl:.01,totalPnl:0}}]
  ]) assert.equal(evaluateSignalReadiness(...mutation).ready, false);
});

test("universe rejects stable, wrapped and leveraged instruments", () => {
  const base={status:"Trading",quoteCoin:"USDT",contractType:"LinearPerpetual"};
  assert.equal(isEligibleInstrument({...base,symbol:"BTCUSDT"}),true);
  assert.equal(isEligibleInstrument({...base,symbol:"USDCUSDT"}),false);
  assert.equal(isEligibleInstrument({...base,symbol:"WBTCUSDT"}),false);
  assert.equal(isEligibleInstrument({...base,symbol:"BTC3LUSDT"}),false);
});

test("universe ranking prefers stronger tradability", () => {
  const info=["AAAUSDT","BBBUSDT"].map(symbol=>({symbol,status:"Trading",quoteCoin:"USDT",contractType:"LinearPerpetual",baseCoin:symbol.slice(0,3)}));
  const tickers=[
    {symbol:"AAAUSDT",turnover24h:1e9,volume24h:1e8,lastPrice:10,fundingRate:0},
    {symbol:"BBBUSDT",turnover24h:1e6,volume24h:1e5,lastPrice:10,fundingRate:0.001}
  ];
  const books=new Map([
    ["AAAUSDT",{spreadBps:1,depthUsd:1e7,fresh:true}],
    ["BBBUSDT",{spreadBps:14,depthUsd:1e3,fresh:false}]
  ]);
  assert.equal(rankEligibleUniverse(info,tickers,books,2)[0].symbol,"AAAUSDT");
});

test("intelligence blocks stale/thin data", () => {
  const e=createIntelligenceEngine();
  const f=e.features("x");
  assert.equal(f.action,"NO TRADE");
  assert.equal(f.microstructure_quality,false);
});
