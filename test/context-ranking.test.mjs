import test from "node:test";
import assert from "node:assert/strict";
import { buildPerformanceProfile } from "../research/performance-profile.mjs";
import { rankStrategyContexts } from "../research/context-ranking.mjs";

function make({family,symbol,regime,n=80,win=9,loss=-4}){
  return Array.from({length:n},(_,i)=>({
    family,symbol,regime,side:regime==="TREND_DOWN"?"SELL":"BUY",
    closedAt:new Date(1700000000000+i*60000).toISOString(),
    netBps:i%5===0?loss:win,
    grossBps:(i%5===0?loss:win)+7,
    costBps:7
  }));
}

test("ranking puts proven healthy contexts ahead of degraded contexts",()=>{
  const profile=buildPerformanceProfile([
    ...make({family:"TREND_CONTINUATION_V1",symbol:"BTCUSDT",regime:"TREND_UP",n:100,win:12,loss:-4}),
    ...make({family:"TREND_CONTINUATION_V1",symbol:"XRPUSDT",regime:"TREND_UP",n:70,win:-2,loss:-8})
  ]);
  const ranked=rankStrategyContexts(profile);
  assert.equal(ranked.length,2);
  assert.equal(ranked[0].symbol,"BTCUSDT");
  assert.equal(ranked[0].status,"HEALTHY");
  assert.equal(ranked[1].symbol,"XRPUSDT");
  assert.equal(ranked[1].status,"DEGRADED");
  assert.equal(ranked[1].researchBlocked,true);
});
