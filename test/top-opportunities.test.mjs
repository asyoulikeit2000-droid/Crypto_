import test from 'node:test';
import assert from 'node:assert/strict';
import {rankTopOpportunities,scoreOpportunity} from '../top-opportunities.mjs';

const base=(i,p=.72)=>({asset_id:`a${i}`,symbol:`C${i}`,signal:'LONG',p_t1:p,expected_value:.01,data_quality:'HIGH',spread_bps:4,snapshot:{feature:{return_15m:.01,cvd_10m:.3,orderbook_imbalance:.2}}});
const ctx={h4Trend:.5,d1Trend:.6,mtfAlignment:.5,cycleBias:.4,maStructure:.5,macd:.4,rsiQuality:.3,fibConfluence:.4,openInterestImpulse:.3,fundingSupport:.2,rewardRisk:2};

test('returns at most five unique assets ordered by score',()=>{
  const candidates=Array.from({length:10},(_,i)=>base(i,.60+i*.02));
  const contexts=Object.fromEntries(candidates.map(x=>[x.asset_id,ctx]));
  const out=rankTopOpportunities(candidates,contexts,5);
  assert.equal(out.length,5);
  assert.ok(out.every((x,i)=>i===0||out[i-1].opportunity_score>=x.opportunity_score));
});

test('does not fill five when only two qualify',()=>{
  const candidates=[base(1),base(2),{...base(3),expected_value:-.01},{...base(4),data_quality:'LOW'}];
  const contexts={a1:ctx,a2:ctx,a3:ctx,a4:ctx};
  assert.equal(rankTopOpportunities(candidates,contexts).length,2);
});

test('blocks strong higher-timeframe conflict',()=>{
  const c=base(1,.85);
  assert.equal(scoreOpportunity(c,{...ctx,h4Trend:-.7,d1Trend:-.8}),null);
});

test('paper breadth cannot bypass top-five cap',()=>{
  const candidates=Array.from({length:30},(_,i)=>base(i,.75));
  const contexts=Object.fromEntries(candidates.map(x=>[x.asset_id,ctx]));
  assert.equal(rankTopOpportunities(candidates,contexts,99).length,5);
});
