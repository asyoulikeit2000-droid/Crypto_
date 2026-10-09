import test from "node:test";
import assert from "node:assert/strict";
import { defaultShadowCostAssumptions, createBinanceShadowService } from "../research/binance-shadow-service.mjs";

test("shadow service keeps conservative all-in cost assumptions",()=>{
  const c=defaultShadowCostAssumptions({});
  assert.equal(c.entryFeeRate,0.0002);
  assert.equal(c.exitFeeRate,0.0005);
  assert.equal(c.entrySlippageBps,0.5);
  assert.equal(c.exitSlippageBps,1);
  assert.equal(c.spreadCrossingBps,0.5);
});

test("shadow service state explicitly has no live-order capability",()=>{
  class FakeWebSocket {
    constructor(){this.readyState=1;}
    addEventListener(){}
    close(){}
  }
  async function db(){ return []; }
  const service=createBinanceShadowService({
    db,
    markHealth:async()=>{},
    env:{SHADOW_SYMBOLS:"BTCUSDT,SOLUSDT"},
    WebSocketImpl:FakeWebSocket,
    fetchImpl:async()=>({ok:true,json:async()=>({openInterest:"1",time:1})})
  });
  const s=service.state();
  assert.equal(s.mode,"SHADOW_RESEARCH_ONLY");
  assert.equal(s.liveOrdersPossible,false);
  assert.deepEqual(s.symbols,["BTCUSDT","SOLUSDT"]);
});
