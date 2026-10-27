import test from 'node:test';
import assert from 'node:assert/strict';
import {compactSignalLedger} from '../signal-ledger.mjs';
import {selectSetups,reviewDay} from '../mtf-strategy.mjs';
const now=Date.UTC(2026,9,13,9);
const record=i=>({id:'s'+i,symbol:'S'+i,family:i%2?'H4_LED':'DAILY_ALIGNED',candleAt:now-3600000+i,createdAt:now-60000+i,entryValidUntil:now+3600000,status:'OPEN'});
const ledger=signals=>({version:1,savedAt:now,symbols:['BTCUSDT'],histories:{},signals});
test('count compaction preserves the five-per-day ceiling and duplicate watermarks',()=>{
 const value=ledger(Array.from({length:12},(_,i)=>record(i)));
 const next=compactSignalLedger(value,now,{maxRecords:5});
 assert.equal(next.signals.length,5);
 assert.deepEqual(next.signals.map(s=>s.id),['s7','s8','s9','s10','s11']);
 assert.equal(next.archivedPublicationsByDay[reviewDay(now)],7);
 assert.equal(next.archivedPublicationsByDay[reviewDay(now)]+next.signals.length,12);
 assert.equal(next.triggerWatermarks.S0,value.signals[0].candleAt);
 assert.equal(selectSetups([{eligible:true,symbol:'NEW',candleAt:now,score:90,direction:'LONG'}],next.signals,now,{archivedPublicationsByDay:next.archivedPublicationsByDay}).length,0);
 const again=compactSignalLedger(JSON.parse(JSON.stringify(next)),now,{maxRecords:5});
 assert.deepEqual(again,next);
});
test('legacy simulated metrics and paper cursors are excluded from new checkpoints',()=>{
 const old={...record(0),simulation:{status:'TP1',netPnlUsdt:100},paperCursor:now,lastPaperClose:102};
 const value={...ledger([old]),simulationArchive:{tp:9},simulationFamilyArchive:{DAILY_ALIGNED:{tp:9}}};
 const next=compactSignalLedger(value,now);
 assert.equal(next.signals.length,1);
 assert.equal(next.signals[0].simulation,undefined);
 assert.equal(next.signals[0].paperCursor,undefined);
 assert.equal(next.signals[0].lastPaperClose,undefined);
 assert.equal(next.simulationArchive,undefined);
 assert.equal(next.simulationFamilyArchive,undefined);
 assert(value.signals[0].simulation);
});
test('byte compaction retains newest manual signals and records evicted publications',()=>{
 const a={...record(0),evidence:'x'.repeat(2000)},b={...record(1),evidence:'y'.repeat(2000)};
 const next=compactSignalLedger(ledger([a,b]),now,{maxBytes:3500});
 assert.deepEqual(next.signals,[b]);
 assert.equal(next.archivedPublicationsByDay[reviewDay(now)],1);
 const tiny=compactSignalLedger(ledger([a]),now,{maxBytes:1000});
 assert.equal(tiny.signals.length,0);
 assert.equal(tiny.archivedPublicationsByDay[reviewDay(now)],1);
 assert.throws(()=>compactSignalLedger(ledger([]),now,{maxBytes:1}),/capacity/);
});
test('old manual signals expire with archival daily counts pruned after seven days',()=>{
 const old={...record(0),createdAt:now-8*86400000,simulation:{status:'OPEN'}};
 const next=compactSignalLedger(ledger([old]),now);
 assert.equal(next.signals.length,0);
 assert.equal(next.archivedPublicationsByDay[reviewDay(old.createdAt)],undefined);
 assert.equal(next.simulationArchive,undefined);
});
