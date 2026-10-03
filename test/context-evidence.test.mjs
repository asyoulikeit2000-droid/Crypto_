import test from "node:test";
import assert from "node:assert/strict";
import { buildPerformanceProfile } from "../research/performance-profile.mjs";
import { evaluateContextEvidence } from "../strategy/context-evidence.mjs";

function rows({family="TREND_CONTINUATION_V1",symbol="BTCUSDT",regime="TREND_UP",n=80,winBps=9,lossBps=-5}={}){
  return Array.from({length:n},(_,i)=>({
    family,symbol,regime,side:"BUY",
    closedAt:new Date(1700000000000+i*60000).toISOString(),
    netBps:i%4===0?lossBps:winBps,
    grossBps:(i%4===0?lossBps:winBps)+7,
    costBps:7
  }));
}

test("hierarchical context can be healthy only with positive family symbol regime and context evidence",()=>{
  const p=buildPerformanceProfile([
    ...rows({symbol:"BTCUSDT",n:120}),
    ...rows({symbol:"ETHUSDT",n:80})
  ]);
  const r=evaluateContextEvidence(p,{
    family:"TREND_CONTINUATION_V1",
    symbol:"BTCUSDT",
    regime:"TREND_UP"
  });
  assert.equal(r.status,"HEALTHY");
  assert.equal(r.executionEligible,true);
  assert.equal(r.researchBlocked,false);
  assert.ok(r.conservativeNetBps>0);
});

test("a losing symbol regime is blocked even when the family is profitable elsewhere",()=>{
  const p=buildPerformanceProfile([
    ...rows({symbol:"BTCUSDT",n:240,winBps:12,lossBps:-4}),
    ...rows({symbol:"XRPUSDT",n:70,winBps:-2,lossBps:-7})
  ]);
  const family=p.families.TREND_CONTINUATION_V1;
  assert.ok(family.avgNetBps>0);

  const r=evaluateContextEvidence(p,{
    family:"TREND_CONTINUATION_V1",
    symbol:"XRPUSDT",
    regime:"TREND_UP"
  });
  assert.equal(r.status,"DEGRADED");
  assert.equal(r.researchBlocked,true);
  assert.equal(r.executionEligible,false);
});

test("new combinations stay researchable while learning but are not execution eligible",()=>{
  const p=buildPerformanceProfile(rows({symbol:"BTCUSDT",n:100}));
  const r=evaluateContextEvidence(p,{
    family:"TREND_CONTINUATION_V1",
    symbol:"SOLUSDT",
    regime:"TREND_UP"
  });
  assert.equal(r.status,"LEARNING");
  assert.equal(r.researchBlocked,false);
  assert.equal(r.executionEligible,false);
});
