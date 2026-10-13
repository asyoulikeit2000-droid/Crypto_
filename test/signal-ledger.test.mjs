import test from 'node:test';
import assert from 'node:assert/strict';
import {compactSignalLedger} from '../signal-ledger.mjs';
import {selectSetups,reviewDay} from '../mtf-strategy.mjs';
import {simulationTotals} from '../simulated-trades.mjs';
const now=Date.UTC(2026,9,13,9);
const record=(i,status='TP1')=>({id:'s'+i,symbol:'S'+i,family:i%2?'H4_LED':'DAILY_ALIGNED',candleAt:now-3600000+i,createdAt:now-60000+i,entryValidUntil:now+3600000,simulation:{status,netPnlUsdt:status==='TP1'?100:-50}});
const ledger=signals=>({version:1,savedAt:now,symbols:['BTCUSDT'],histories:{},signals});
test('count compaction archives oldest completed receipts without resetting totals or today counts',()=>{
 const value=ledger(Array.from({length:12},(_,i)=>record(i,i%3?'TP1':'STOP'))),before=simulationTotals(value.signals);
 const next=compactSignalLedger(value,now,{maxRecords:5});assert.equal(next.signals.length,5);assert.equal(value.signals.length,12);assert.deepEqual(next.signals.map(s=>s.id),['s7','s8','s9','s10','s11']);
 const after=simulationTotals(next.signals,next.simulationArchive);assert.equal(after.tp,before.tp);assert.equal(after.stop,before.stop);assert.equal(after.netPnlUsdt,before.netPnlUsdt);assert.equal(after.winRate,before.winRate);
 assert.equal(next.archivedPublicationsByDay[reviewDay(now)]+next.signals.length,12);assert.equal(next.triggerWatermarks.S0,value.signals[0].candleAt);
 assert.equal(selectSetups([{eligible:true,symbol:'S0',candleAt:value.signals[0].candleAt,score:90,direction:'LONG'}],next.signals,now,{triggerWatermarks:next.triggerWatermarks}).length,0);
 const again=compactSignalLedger(JSON.parse(JSON.stringify(next)),now,{maxRecords:5});assert.deepEqual(again,next);
});
test('per-family aggregates retain wins and losses through archival',()=>{
 const next=compactSignalLedger(ledger([record(0,'STOP'),record(1),record(2),record(3,'STOP')]),now,{maxRecords:1});
 for(const family of ['DAILY_ALIGNED','H4_LED']){const total=simulationTotals(next.signals.filter(s=>s.family===family),next.simulationFamilyArchive[family]);assert.equal(total.tp,1);assert.equal(total.stop,1);assert.equal(total.winRate,50);}
});
test('byte compaction preserves active simulation evidence and fails rather than evicting it',()=>{
 const active={...record(0,'OPEN'),evidence:'x'.repeat(2000)},done={...record(1),evidence:'y'.repeat(2000)};
 const next=compactSignalLedger(ledger([active,done]),now,{maxBytes:3500});assert.deepEqual(next.signals,[active]);assert.equal(next.simulationArchive.tp,1);
 assert.throws(()=>compactSignalLedger(ledger([active]),now,{maxBytes:1000}),/capacity/);
 assert.throws(()=>compactSignalLedger(ledger([record(0,'OPEN'),record(1,'OPEN')]),now,{maxRecords:1}),/capacity/);
});
test('expired unknown positions are explicitly unresolved, not counted as wins',()=>{
 const old={...record(0,'OPEN'),createdAt:now-8*86400000};const next=compactSignalLedger(ledger([old]),now);assert.equal(next.signals.length,0);assert.equal(next.simulationArchive.unresolved,1);assert.equal(next.simulationArchive.tp,0);assert.equal(next.simulationArchive.stop,0);assert.equal(next.archivedPublicationsByDay[reviewDay(old.createdAt)],undefined);
});
