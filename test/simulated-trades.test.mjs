import test from 'node:test';
import assert from 'node:assert/strict';
import {initSimulation,advanceSimulation,simulationTotals,simulationView,SIM_NOTIONAL,retainedPerformance} from '../simulated-trades.mjs';
const at=Date.UTC(2026,9,12,1),signal={id:'test',symbol:'BTCUSDT',entry:100,stop:98,targets:[102,104,106],direction:'LONG',createdAt:at,horizonHours:48};
const bar=(t,o=100,h=101,l=99,c=100)=>[t,o,h,l,c,1,1];
test('quality metrics expose unequal losses despite 50% wins and exclude open evidence',()=>{
 const rows=[['TP1',200],['STOP',-400],['TIMEOUT',50],['OPEN',1000],['UNRESOLVED',1000]].map(([status,netPnlUsdt])=>({...signal,simulation:{status,netPnlUsdt,closedAt:at+60000}}));
 const result=retainedPerformance(rows);
 assert.equal(result.count,3);assert.equal(result.profitFactor,.625);assert.equal(result.averagePnlUsdt,-50);
 const total=simulationTotals(rows,{tp:10,stop:10,netPnlUsdt:123});
 assert.equal(total.winRate,50);assert.equal(total.netPnlUsdt,-27);
 assert.deepEqual(total.retainedPerformance,result); // archived gain/loss components cannot be inferred
});
test('quality metrics never claim infinite profit factor or manufactured zero-trade expectancy',()=>{
 const empty=retainedPerformance([]);assert.equal(empty.profitFactor,null);assert.equal(empty.averagePnlUsdt,null);assert.equal(empty.noLosses,false);
 const win=retainedPerformance([{...signal,simulation:{status:'TP1',netPnlUsdt:200}}]);assert.equal(win.profitFactor,null);assert.equal(win.noLosses,true);assert.equal(win.averagePnlUsdt,200);
 const missing=retainedPerformance([{...signal,simulation:{status:'STOP',netPnlUsdt:null}}]);assert.equal(missing.count,0);
});
test('assumes 15000 notional and closes the full position at first TP, after fees',()=>{
 const sim=advanceSimulation(signal,[bar(at,100,103,99,102)],at+60000);assert.equal(SIM_NOTIONAL,15000);assert.equal(sim.status,'TP1');assert.equal(sim.exit,102);assert.ok(Math.abs(sim.netPnlUsdt-278.79)<1e-8);assert.equal(sim.assumedEntry,100);
 const later=advanceSimulation({...signal,simulation:sim},[bar(at+60000,100,101,95,96)],at+120000);assert.deepEqual(later,sim);
});
test('stop gaps fill adversely; same-minute TP and stop are counted conservatively',()=>{
 const gap=advanceSimulation(signal,[bar(at,97,103,96,101)],at+60000);assert.equal(gap.status,'STOP');assert.equal(gap.exit,97);assert.equal(gap.ambiguous,true);assert.ok(gap.netPnlUsdt<-450);
 const short={...signal,direction:'SHORT',stop:102,targets:[98,96,94]};assert.equal(advanceSimulation(short,[bar(at,103,104,97,101)],at+60000).exit,103);
});
test('entry-minute pre-fill ordering is unresolved and excluded from win rate',()=>{
 const s={...signal,createdAt:at+30000};const sim=advanceSimulation(s,[bar(at,100,103,99,102)],at+60000);assert.equal(sim.status,'UNRESOLVED');assert.equal(simulationTotals([{simulation:sim}]).winRate,null);
});
test('missing minutes never invent success, and recovery resumes without losing the cursor',()=>{
 let sim=advanceSimulation(signal,[bar(at+60000,100,103,99,102)],at+120000);assert.equal(sim.status,'OPEN');assert.equal(sim.cursor,at);
 sim=advanceSimulation({...signal,simulation:sim},[bar(at),bar(at+60000,100,103,99,102)],at+120000);assert.equal(sim.status,'TP1');
});
test('only closed valid candles count; no future or impossible-price outcomes',()=>{
 for(const rows of [[bar(at,100,103,99,102)],[[at,100,98,101,100,1,1]],[[at,100,NaN,99,100,1,1]]])assert.equal(advanceSimulation(signal,rows,at+30000).status,'OPEN');
});
test('pagination persists progress and timeout waits for continuous deadline evidence',()=>{
 const rows=Array.from({length:1000},(_,i)=>bar(at+i*60000));let sim=advanceSimulation(signal,rows,at+2880*60000);assert.equal(sim.status,'OPEN');assert.equal(sim.cursor,at+1000*60000);
 for(let start=1000;start<2880;start+=1000)sim=advanceSimulation({...signal,simulation:sim},Array.from({length:Math.min(1000,2880-start)},(_,i)=>bar(at+(start+i)*60000)),at+2880*60000);
 assert.equal(sim.status,'TIMEOUT');assert.ok(sim.netPnlUsdt<0);assert.equal(simulationTotals([{simulation:sim}]).winRate,null);
});
test('aggregate win rate includes archived resolved outcomes, excludes open/unknown/timeout',()=>{
 const s=status=>({simulation:{status,netPnlUsdt:status==='TP1'?100:-50}});const t=simulationTotals([s('TP1'),s('STOP'),s('UNRESOLVED'),s('TIMEOUT'),s('OPEN')],{tp:2,stop:0,netPnlUsdt:200});assert.equal(t.winRate,75);assert.equal(t.netPnlUsdt,200);assert.equal(t.open,1);assert.equal(t.unresolved,1);
});
test('live mark uses position size and stale feeds remove mark availability, not closed outcomes',()=>{
 const market={price:101,bookAt:at,tradeAt:at,receivedAt:at};const sim=simulationView(signal,market,at+1000);assert.ok(sim.markPnlUsdt>0);assert.equal(sim.catchingUp,true);assert.equal(simulationView(signal,market,at+91000).markPnlUsdt,null);
 const closed=advanceSimulation(signal,[bar(at,100,103,99,102)],at+60000);assert.ok(Math.abs(simulationView({...signal,simulation:closed},market,at+91000).netPnlUsdt-278.79)<1e-8);
});
