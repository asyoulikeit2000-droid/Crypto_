import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeExecutionAttempts,
  buildExecutionQualityProfile,
  evaluateExecutionQuality
} from "../research/execution-quality.mjs";

function attempts({family="TREND_CONTINUATION_V1",symbol="BTCUSDT",regime="TREND_UP",n=40,fillEvery=2,start=1700000000000}={}){
  return Array.from({length:n},(_,i)=>{
    const filled=i%fillEvery===0;
    const opened=new Date(start+i*60_000).toISOString();
    return {
      trial_id:`ATTEMPT:${family}:${symbol}:${i}`,
      family,symbol,regime,
      status:filled?"FILLED":"EXPIRED",
      opened_at:opened,
      closed_at:new Date(start+i*60_000+10_000).toISOString(),
      metadata:{
        attempt_only:true,
        fill_latency_ms:filled?4000+i*10:null
      }
    };
  });
}

test("execution summary measures fill rate latency expiry and throughput",()=>{
  const rows=attempts({n:40,fillEvery:2});
  const s=summarizeExecutionAttempts(rows,{now:1700000000000+6*3600_000});
  assert.equal(s.completedCount,40);
  assert.equal(s.filledCount,20);
  assert.equal(s.expiredCount,20);
  assert.equal(s.fillRate,0.5);
  assert.ok(s.avgFillLatencyMs>0);
  assert.ok(s.attemptsPerDay>0);
  assert.ok(s.filledPerDay>0);
});

test("execution quality profiles by family symbol regime and exact context",()=>{
  const p=buildExecutionQualityProfile([
    ...attempts({symbol:"BTCUSDT",n:20}),
    ...attempts({symbol:"ETHUSDT",n:20})
  ]);
  assert.equal(p.families.TREND_CONTINUATION_V1.attemptCount,40);
  assert.equal(p.contexts["TREND_CONTINUATION_V1|BTCUSDT|TREND_UP"].attemptCount,20);
});

test("statistically poor maker fill rate becomes execution degraded",()=>{
  const s=summarizeExecutionAttempts(attempts({n:40,fillEvery:10}));
  const q=evaluateExecutionQuality(s);
  assert.equal(q.status,"DEGRADED");
  assert.equal(q.executionBlocked,true);
  assert.ok(q.reasons.includes("lowMakerFillRate"));
});

test("no attempts is learning rather than falsely bad",()=>{
  const s=summarizeExecutionAttempts([]);
  const q=evaluateExecutionQuality(s);
  assert.equal(q.status,"LEARNING");
  assert.equal(q.executionBlocked,false);
  assert.equal(s.fillRate,null);
});
