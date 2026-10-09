import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {scenarios} from '../mtf-strategy.mjs';
const source=await readFile(new URL('../public/free-app.js',import.meta.url),'utf8'),now=Date.UTC(2026,9,9,12);
function dashboard(actionable=true,storageAge=0,feedAge=0){
 const elements=Object.fromEntries(['health','notional','signals','markets','details','context','footer'].map(id=>[id,{innerHTML:'',textContent:'',value:'1000',addEventListener(){}}]));
 const s={id:'x',symbol:'BTCUSDT',strategy:'TREND_BREAKOUT',direction:'LONG',score:90,status:'OPEN',createdAt:now,entryValidUntil:now+3600000,entry:100.15,stop:98.05,targets:[102.25,104.35,106.45],entryZone:[100,100.3],riskPct:.02,tickSize:'0.05',pnl:scenarios(100.15,98.05,[102.25,104.35,106.45],'LONG'),analysis:{d1:'UP',h4:'UP',h1:'UP',volumeRatio:2},entryStatus:{actionable,reason:actionable?'Within entry zone':'Outside entry zone; do not chase'},context:{checkedAt:now,flow:{netInflowUsd:10,activeAddresses:1000},newsMethod:'Headline risk checks',headlines:[{title:'<script>bad</script>',url:'https://example.com',publishedAt:now}]}};
 const sample={health:{context:{ok:true},markets:[{symbol:'BTCUSDT',price:100.15,bookAt:now-feedAge,tradeAt:now-feedAge,receivedAt:now-feedAge}],storage:{ok:true,lastSuccess:now-storageAge,plannedLogicalWritesPerDay:720,indexedWriteEstimatePerDay:7920},feed:{total:1},selectedToday:1,dailyCap:4,revision:'test'},signals:[s],review:[],context:{selectionImpact:'Context gates',onchain:{available:false,reason:'Unavailable'},economicCalendar:{events:[],sources:[],reason:'Schedules loaded'},tokenOnchain:{assets:{BTCUSDT:{flowAvailable:true,inflowUsd:100,outflowUsd:90,netInflowUsd:10,activeAddresses:1000,periodEnd:now}},reason:'Daily provider flows'},feeds:[]}};
 const sandbox=vm.createContext({sample,Date:class extends Date{static now(){return now;}},document:{getElementById:id=>elements[id]},fetch:async()=>({ok:true,json:async()=>sample}),setInterval(){},URL,console});
 vm.runInContext(source,sandbox);vm.runInContext('data=sample;lastResponse=Date.now();render()',sandbox);
 return elements;
}
test('final card renders exact entry/SL/three TPs, strategy, context and expiry safely',()=>{const e=dashboard();assert.match(e.signals.innerHTML,/100.15/);assert.match(e.signals.innerHTML,/98.05/);assert.match(e.signals.innerHTML,/102.25/);assert.match(e.signals.innerHTML,/104.35/);assert.match(e.signals.innerHTML,/106.45/);assert.match(e.signals.innerHTML,/SL/);assert.match(e.signals.innerHTML,/TREND_BREAKOUT/);assert.match(e.signals.innerHTML,/Entry review available/);assert.match(e.signals.innerHTML,/Valid until/);assert.match(e.signals.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(e.signals.innerHTML,/<script>bad/);assert.match(e.context.innerHTML,/Upcoming US economic/);});
test('non-actionable archived card keeps its evidence without inviting a new entry',()=>{const e=dashboard(false);assert.match(e.signals.innerHTML,/do not chase/);assert.doesNotMatch(e.signals.innerHTML,/Entry review available/);});

test('client-side stale storage and feed overrides an earlier actionable response',()=>{
 const storage=dashboard(true,301000),feed=dashboard(true,0,91000);assert.match(storage.signals.innerHTML,/Persistence unavailable; entry blocked/);assert.match(feed.signals.innerHTML,/Market feed stale; entry blocked/);for(const e of [storage,feed])assert.doesNotMatch(e.signals.innerHTML,/Entry review available/);
});
