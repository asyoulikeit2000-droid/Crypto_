import test from "node:test";
import assert from "node:assert/strict";
import { summarizeStrategyTrades } from "../strategy/performance-metrics.mjs";
import { selectChampion } from "../strategy/champion-challenger.mjs";

function trades({n=400,netBps=8,costBps=7,symbols=["BTCUSDT","ETHUSDT","SOLUSDT"]}={}) {
  return Array.from({length:n},(_,i)=>({
    closedAt:new Date(1700000000000+i*60000).toISOString(),
    symbol:symbols[i%symbols.length],
    netBps: i%5===0 ? -12 : netBps,
    grossBps: (i%5===0 ? -12 : netBps)+costBps,
    costBps
  }));
}

test("performance metrics summarize after-cost trades into promotion inputs", () => {
  const s=summarizeStrategyTrades(trades());
  assert.equal(s.sampleCount,400);
  assert.equal(s.recentSampleCount,100);
  assert.ok(s.winRate>0.7);
  assert.ok(s.avgNetBps>0);
  assert.ok(s.profitFactor>1);
  assert.equal(s.foldCount,5);
  assert.ok(s.positiveFolds>=3);
  assert.ok(s.symbolConcentrationPct<0.5);
});

test("champion selector refuses unproven families", () => {
  const r=selectChampion({
    A:summarizeStrategyTrades(trades({n:50})),
    B:summarizeStrategyTrades(trades({n:60,netBps:10}))
  });
  assert.equal(r.champion,null);
  assert.equal(r.reason,"noPromotedStrategy");
});

test("champion selector picks only a promoted leader with a stable edge", () => {
  const a=summarizeStrategyTrades(trades({n:500,netBps:9}));
  const b=summarizeStrategyTrades(trades({n:500,netBps:4}));
  const r=selectChampion({A:a,B:b},{minChampionLeadBps:0.5});
  assert.equal(r.champion.family,"A");
});
