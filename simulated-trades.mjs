import {closedCandles,freshness,scenarios} from './mtf-strategy.mjs';
export const SIM_NOTIONAL=15000;
const MINUTE=60000;
const terminal=s=>['TP1','STOP','TIMEOUT','UNRESOLVED'].includes(s?.status);
export function initSimulation(signal){
 const {entry,stop,targets,direction,createdAt}=signal;
 if(![entry,stop,targets?.[0],createdAt].every(v=>Number.isFinite(v)&&v>0)||!['LONG','SHORT'].includes(direction))return {status:'UNRESOLVED',reason:'Invalid signal evidence'};
 return {version:1,status:'OPEN',assumedEntryAt:createdAt,assumedEntry:entry,notionalUsdt:SIM_NOTIONAL,cursor:Math.floor(createdAt/MINUTE)*MINUTE,checkedThrough:null,reason:'Assumed fill at published entry; waiting for minute candles'};
}
export function advanceSimulation(signal,raw,now){
 let s=structuredClone(signal.simulation||initSimulation(signal));if(terminal(s))return s;
 const bars=closedCandles(raw,MINUTE,now),side=signal.direction==='LONG'?1:-1;
 const deadline=Math.ceil((signal.createdAt+(signal.horizonHours||48)*3600000)/MINUTE)*MINUTE;
 const finish=(status,exit,b,reason,ambiguous=false)=>({...s,status,exit,closedAt:b[0]+MINUTE,checkedThrough:b[0]+MINUTE,reason,ambiguous,netPnlUsdt:scenarios(signal.entry,exit,[],signal.direction,SIM_NOTIONAL).stop.netBeforeFundingUsd});
 for(const b of bars){
  if(b[0]<s.cursor||b[0]>=deadline)continue;
  if(b[0]!==s.cursor)return {...s,reason:'Missing minute candles; recovery pending'};
  const stopHit=side===1?b[3]<=signal.stop:b[2]>=signal.stop,tpHit=side===1?b[2]>=signal.targets[0]:b[3]<=signal.targets[0];
  if(b[0]<signal.createdAt&&(stopHit||tpHit))return {...s,status:'UNRESOLVED',reason:'Entry-minute price ordering unknown; excluded from win rate',checkedThrough:b[0]+MINUTE};
  if(stopHit){const fill=side===1?Math.min(b[1],signal.stop):Math.max(b[1],signal.stop);return finish('STOP',fill,b,tpHit?'TP and stop in same minute; conservative stop first':'Stop loss hit',tpHit);}
  if(tpHit)return finish('TP1',signal.targets[0],b,'TP1 hit; full hypothetical position closed');
  s={...s,cursor:b[0]+MINUTE,checkedThrough:b[0]+MINUTE,lastClose:b[4],reason:'Minute candles checked; position remains simulated open'};
 }
 if(now>=deadline&&s.cursor>=deadline&&Number.isFinite(s.lastClose))return finish('TIMEOUT',s.lastClose,[deadline-MINUTE],'48-hour simulation window ended; excluded from target/stop win rate');
 return s;
}
export function simulationTotals(signals,archived={}){
 const totals={tp:0,stop:0,timeout:0,unresolved:0,open:0,ambiguous:0,netPnlUsdt:0,...archived};
 for(const signal of signals){const s=signal.simulation;if(!s){totals.open++;continue;}if(s.status==='TP1')totals.tp++;else if(s.status==='STOP')totals.stop++;else if(s.status==='TIMEOUT')totals.timeout++;else if(s.status==='UNRESOLVED')totals.unresolved++;else totals.open++;
  if(s.ambiguous)totals.ambiguous++;if(['TP1','STOP','TIMEOUT'].includes(s.status)&&Number.isFinite(s.netPnlUsdt))totals.netPnlUsdt+=s.netPnlUsdt;
 }
 return {...totals,resolved:totals.tp+totals.stop,winRate:totals.tp+totals.stop?totals.tp/(totals.tp+totals.stop)*100:null,notionalUsdt:SIM_NOTIONAL,method:'Assumed publication-price fill; full exit at TP1 or stop; stop first on same-minute ties; estimated fees/slippage; funding excluded'};
}
export function simulationView(signal,market,now){
 const s=signal.simulation||initSimulation(signal),fresh=freshness(market,now).fresh;
 const marked=s.status==='OPEN'&&fresh&&Number.isFinite(market?.price)&&market.price>0;
 return {...s,markPrice:marked?market.price:null,markAt:marked?market.receivedAt:null,markPnlUsdt:marked?scenarios(signal.entry,market.price,[],signal.direction,SIM_NOTIONAL).stop.netBeforeFundingUsd:null,catchingUp:s.status==='OPEN'&&(!s.checkedThrough||now-s.checkedThrough>120000),simulated:true};
}
