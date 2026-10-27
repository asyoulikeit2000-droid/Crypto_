import {MAX_CHECKPOINT_BYTES,MAX_CHECKPOINT_RECORDS} from './storage/free-checkpoint.mjs';
import {reviewDay} from './mtf-strategy.mjs';
// Compact manual signal receipts only; paper-trading metrics are no longer tracked.
export function compactSignalLedger(value,now=Date.now(),{maxRecords=MAX_CHECKPOINT_RECORDS,maxBytes=MAX_CHECKPOINT_BYTES-2000}={}){
 const next=structuredClone(value);next.triggerWatermarks ||= {};next.archivedPublicationsByDay ||= {};delete next.simulationArchive;delete next.simulationFamilyArchive;
 for(const s of next.signals){delete s.simulation;delete s.paperCursor;delete s.lastPaperClose;if(Number.isFinite(s.candleAt))next.triggerWatermarks[s.symbol]=Math.max(next.triggerWatermarks[s.symbol]||0,s.candleAt);}
 const archive=s=>{
  const day=reviewDay(s.createdAt);next.archivedPublicationsByDay[day]=(next.archivedPublicationsByDay[day]||0)+1;
 };
 next.signals=next.signals.filter(s=>{
  if(now-s.createdAt<=7*86400000)return true;
  archive(s);return false;
 });
 const bytes=()=>Buffer.byteLength(JSON.stringify(next));
 while(next.signals.length>maxRecords||bytes()>maxBytes){
  const removable=next.signals.map((s,i)=>({s,i})).sort((a,b)=>a.s.createdAt-b.s.createdAt)[0];
  if(!removable)throw Error('Signal checkpoint capacity exceeded');
  archive(removable.s);next.signals.splice(removable.i,1);
 }
 const earliest=reviewDay(now-7*86400000);next.archivedPublicationsByDay=Object.fromEntries(Object.entries(next.archivedPublicationsByDay).filter(([day])=>day>=earliest));
 return next;
}
