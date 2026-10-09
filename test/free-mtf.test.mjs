import test from 'node:test';
import assert from 'node:assert/strict';
import {createFreeCheckpoint,MAX_CHECKPOINT_BYTES} from '../storage/free-checkpoint.mjs';
import {closedCandles,candleCoverage,freshness,evaluateMtf,selectSetups,reviewDay,scenarios,advancePaper,INTERVALS,exactLevels,entryState,invalidateEntry} from '../mtf-strategy.mjs';
const now=Date.UTC(2026,9,4,12,2);
const empty=()=>({version:1,savedAt:0,symbols:[],histories:{},signals:[]});
function bars(tf,side=1){const ms=INTERVALS[tf],end=Math.floor(now/ms)*ms;return Array.from({length:220},(_,i)=>{const p=side===1?100+i*.1:150-i*.1;return [end-(220-i)*ms,p,p+.2,p-.2,p+side*.08,100,12000];});}
function setup(side=1){const history=Object.fromEntries(Object.keys(INTERVALS).map(tf=>[tf,bars(tf,side)]));let h=history.H1.at(-1);h[4]+=side*.25;h[2]=Math.max(h[2],h[4]+.03);h[3]=Math.min(h[3],h[4]-.03);h[5]=230;for(const r of history.H1.slice(-6)){if(side===1)r[3]-=.5;else r[2]+=.5;}const market={tickSize:"0.01",price:h[4],spreadBps:1,turnover24h:1e9,bookAt:now-1000,tradeAt:now-1000,receivedAt:now,fundingRate:.0001,oiAt:now-60000,oiChange:.01};return {history,market};}
test('closed candles discard incomplete candles and require continuous, current histories',()=>{const b=bars('H1');assert.equal(candleCoverage(b,'H1',now),true);const open=[Math.floor(now/3600000)*3600000,1,2,.5,1,1,1];assert.equal(closedCandles([...b,open],'H1',now).length,220);assert.equal(candleCoverage(b.filter((_,i)=>i!==100),'H1',now),false);assert.equal(candleCoverage(b,'H1',now+3600000),false);});
test('stale trade, stale book and future event all block independently',()=>{assert.equal(freshness({bookAt:now,tradeAt:now-91000,receivedAt:now},now).fresh,false);assert.equal(freshness({bookAt:now+6000,tradeAt:now,receivedAt:now},now).fresh,false);assert.equal(freshness({bookAt:now-91000,tradeAt:now,receivedAt:now},now).fresh,false);});
test('MTF requires aligned closed history and derivatives, rejects missing and weak input',()=>{const {history,market}=setup();assert.equal(evaluateMtf('BTCUSDT',history,{...market,fundingRate:null},history,now).eligible,false);assert.equal(evaluateMtf('BTCUSDT',history,{...market,tradeAt:now-100000},history,now).eligible,false);assert.equal(evaluateMtf('BTCUSDT',{...history,D1:[]},market,history,now).eligible,false);assert.equal(evaluateMtf('BTCUSDT',history,{...market,oiChange:null},history,now).eligible,false);});
test('daily cap persists across restart, one asset/day and hourly spacing; Dubai rollover',()=>{const candidates=Array.from({length:9},(_,i)=>({eligible:true,symbol:'S'+i,score:90-i,direction:'LONG',candleAt:now}));let signals=selectSetups(candidates,[],now);assert.equal(signals.length,2);assert.equal(selectSetups(candidates,signals,now+60000).length,0);signals.push(...selectSetups(candidates,signals,now+3600000));signals.push(...selectSetups(candidates,JSON.parse(JSON.stringify(signals)),now+7200000));assert.equal(signals.length,4);assert.equal(selectSetups(candidates,signals,now+10800000).length,0);assert.notEqual(reviewDay(Date.UTC(2026,9,4,19,59)),reviewDay(Date.UTC(2026,9,4,20)));});
test('scenarios have explicit costs, direction and no invented expected value',()=>{const long=scenarios(100,98,[102,104,106],'LONG');const short=scenarios(100,102,[98,96,94],'SHORT');assert(long.stop.netBeforeFundingUsd<-20);assert(long.targets[1].netBeforeFundingUsd<40);assert(short.targets[1].netBeforeFundingUsd>0);assert.equal(long.expectedPnlUsd,null);});
test('checkpoint requires successful recovery and does not acknowledge failed writes',async()=>{let t=now,calls=0,fail=false;const db={async db(table,method){if(method==='GET')return [];calls++;if(fail)throw new Error('quota');return [];}};const s=createFreeCheckpoint(db,()=>t);await assert.rejects(s.save(empty()),/recovery/);await s.load();assert(await s.save(empty()));fail=true;t+=120000;await assert.rejects(s.save(empty()),/quota/);assert.equal(s.status().lastSuccess,now);assert.equal(await s.save(empty()),null);assert.equal(calls,2);});
test('24-hour scheduling makes no more than 720 acknowledged document saves',async()=>{let t=now,calls=0;const s=createFreeCheckpoint({async db(_,m){if(m!=='GET')calls++;return [];}},()=>t);await s.load();for(let i=0;i<2880;i++){await s.save(empty());t+=30000;}assert.equal(calls,720);});
test('restart retains throttle and document size bound fails closed',async()=>{const data={...empty(),savedAt:now};const s=createFreeCheckpoint({async db(_,m){assert.equal(m,'GET');return [{data}];}},()=>now+5000);await s.load();assert.equal(await s.save(empty()),null);const big=createFreeCheckpoint({async db(){return [];}},()=>now);await big.load();await assert.rejects(big.save({...empty(),histories:{x:'a'.repeat(MAX_CHECKPOINT_BYTES)}}),/size/);});
test('minute paper evidence uses stop first, gap invalidation, adverse gap fills',()=>{const s={status:'OPEN',entry:100,stop:98,targets:[102,104,106],direction:'LONG',createdAt:now,horizonHours:48,paperCursor:now};const both=advancePaper(s,[[now,100,107,97,103,1,1]],now+60000);assert.equal(both.outcomeReason,'STOP');assert.equal(both.ambiguous,true);const gap=advancePaper(s,[[now+60000,100,101,99,100,1,1]],now+120000);assert.equal(gap.status,'INVALID_EVIDENCE');const adverse=advancePaper(s,[[now,97,99,96,98,1,1]],now+60000);assert.equal(adverse.exit,97);});
test('paper recovery retains a full 1000-minute page and ignores post-deadline candles',()=>{const s={status:'OPEN',entry:100,stop:98,targets:[102,104,106],direction:'LONG',createdAt:now,horizonHours:48,paperCursor:now};const rows=Array.from({length:900},(_,i)=>[now+i*60000,100,101,99,100,1,1]);assert.equal(advancePaper(s,rows,now+900*60000).status,'OPEN');const expired={...s,horizonHours:1/60};assert.equal(advancePaper(expired,[[now,100,101,99,100,1,1],[now+60000,100,107,97,100,1,1]],now+120000).outcomeReason,'TIMEOUT');});
test('aligned long and short examples qualify without a directional sign inversion',()=>{for(const side of [1,-1]){const {history,market}=setup(side);const result=evaluateMtf('BTCUSDT',history,market,history,now);assert.equal(result.eligible,true,result.reason);assert.equal(result.direction,side===1?'LONG':'SHORT');assert(result.score>=80);assert.equal(result.probability,null);}});
test('compact checkpoint preserves 30-symbol ledger and rejects a 31st symbol',async()=>{
  const value={...empty(),symbols:Array.from({length:30},(_,i)=>'S'+i),signals:[{symbol:'BTCUSDT',createdAt:now,entryValidUntil:now+3600000}],histories:{}};
  let written;const store=createFreeCheckpoint({async db(_,method,_params,body){if(method==='GET')return [];written=body.data;return [{data:body.data}];}},()=>now);
  await store.load();await store.save(value);assert.equal(written.symbols.length,30);assert.deepEqual(written.histories,{});assert.equal(written.signals[0].createdAt,now);
  const next=createFreeCheckpoint({async db(){return [];}},()=>now);await next.load();await assert.rejects(next.save({...value,symbols:[...value.symbols,'S30']}),/bounds/);
});
test('exact price levels obey tick size, directional order and reject missing rules',()=>{
 for(const direction of ['LONG','SHORT']){const l=exactLevels(100.123,direction==='LONG'?98.012:102.034,direction==='LONG'?[102.234,104.456,106.789]:[98.012,96.034,94.056],direction,'0.05');for(const v of [l.entry,l.stop,...l.targets])assert(Math.abs(v/.05-Math.round(v/.05))<1e-8);const side=direction==='LONG'?1:-1;assert(side*(l.entry-l.stop)>0);assert(l.targets.every(t=>side*(t-l.entry)>0));}
 assert.throws(()=>exactLevels(100,98,[102,104,106],'LONG',null),/tick/);
});
test('manual entry availability rejects expiration, stale prices, lost persistence and chasing',()=>{
 const s={status:"OPEN",entryValidUntil:now+3600000,entryZone:[99.9,100.1]},m={price:100,bookAt:now,tradeAt:now,receivedAt:now};
 assert.equal(entryState(s,m,now,true).actionable,true);
 assert.equal(entryState(s,m,now,false).actionable,false);
 assert.equal(entryState(s,{...m,price:101},now,true).actionable,false);
 assert.equal(entryState(s,{...m,bookAt:now-91000},now,true).actionable,false);
 assert.equal(entryState({...s,entryValidUntil:now},m,now,true).actionable,false);
});
test('short and long entry zones stay near reference and inside stop and TP1',()=>{
 for(const side of [1,-1]){const {history,market}=setup(side),s=evaluateMtf('BTCUSDT',history,market,history,now);assert(s.eligible);assert(s.entryZone[0]<=s.entry&&s.entry<=s.entryZone[1]);assert(s.entryZone[1]-s.entryZone[0]<=s.analysis.atr*.301);}
});
test('trend pullback qualifies in both directions with a closed recovery and structural risk',()=>{
 for(const side of [1,-1]){
  const history=Object.fromEntries(Object.keys(INTERVALS).map(tf=>[tf,bars(tf)]));const values=[121.2,120.9,120.4,120.7,121.0];
  for(let i=0;i<5;i++){const r=history.H1[215+i];r[1]=i?values[i-1]:121.4;r[4]=values[i];r[2]=Math.max(r[1],r[4])+.15;r[3]=Math.min(r[1],r[4])-.15;r[5]=i===4?230:100;}
  history.H1[217][3]=119.2;
  if(side===-1)for(const rows of Object.values(history))for(const r of rows){r[1]=250-r[1];const hi=250-r[3];r[3]=250-r[2];r[2]=hi;r[4]=250-r[4];}
  const market={tickSize:'0.01',price:history.H1.at(-1)[4],spreadBps:1,turnover24h:1e9,bookAt:now,tradeAt:now,receivedAt:now,fundingRate:.0001,oiAt:now-60000,oiChange:.01};
  const s=evaluateMtf('BTCUSDT',history,market,history,now);assert.equal(s.eligible,true,s.reason);assert.equal(s.strategy,'TREND_PULLBACK');assert.equal(s.direction,side===1?'LONG':'SHORT');
  history.H1.at(-1)[5]=90;assert.equal(evaluateMtf('BTCUSDT',history,market,history,now).eligible,false);
 }
});
test('observed stop or TP1 cancels entry irreversibly without claiming a paper outcome',()=>{
 const s={status:'OPEN',direction:'LONG',stop:98,targets:[102,104,106]},m={price:102,bookAt:now,tradeAt:now,receivedAt:now};
 const cancelled=invalidateEntry(s,m,now);assert.equal(cancelled.status,'INVALIDATED');assert.match(cancelled.invalidationReason,/not a tracked/);assert.equal(invalidateEntry(cancelled,{...m,price:100},now+1000).status,'INVALIDATED');
 assert.equal(invalidateEntry(s,{...m,price:98},now).status,'INVALIDATED');assert.equal(invalidateEntry(s,{...m,bookAt:now-91000},now).status,'OPEN');
});
