import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {scenarios} from '../mtf-strategy.mjs';
const source=await readFile(new URL('../public/free-app.js',import.meta.url),'utf8'),now=Date.UTC(2026,9,9,12);
function dashboard(actionable=true,storageAge=0,feedAge=0,configure=()=>{}){
 const elements=Object.fromEntries(['health','notional','signals','markets','details','context','footer','market-cards','market-summary','market-filter','market-dialog','market-title','market-detail','market-close','simulation-metrics','simulation-trades','simulation-note','detail-dialog','detail-title','detail-body','detail-close','theme-toggle'].map(id=>[id,{innerHTML:'',textContent:'',value:'1000',open:false,handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},setAttribute(name,value){this[name]=value;},querySelectorAll(){return [];},showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();}}]));
 const s={id:'x',symbol:'BTCUSDT',strategy:'TREND_BREAKOUT',direction:'LONG',score:90,status:'OPEN',createdAt:now,entryValidUntil:now+3600000,entry:100.15,stop:98.05,targets:[102.25,104.35,106.45],entryZone:[100,100.3],riskPct:.02,tickSize:'0.05',pnl:scenarios(100.15,98.05,[102.25,104.35,106.45],'LONG'),analysis:{d1:'UP',h4:'UP',h1:'UP',volumeRatio:2},entryStatus:{actionable,reason:actionable?'Within entry zone':'Outside entry zone; do not chase'},context:{checkedAt:now,flow:{netInflowUsd:10,activeAddresses:1000},newsMethod:'Headline risk checks',headlines:[{title:'<script>bad</script>',url:'https://example.com',publishedAt:now}]}};
 const sample={venueContext:{available:true,fetchedAt:now,markets:{BTCUSDT:{source:'OKX',instrument:'BTC-USDT-SWAP',price:100.15,at:now}}},health:{context:{ok:true},markets:[{symbol:'BTCUSDT',price:100.15,bookAt:now-feedAge,tradeAt:now-feedAge,receivedAt:now-feedAge}],storage:{ok:true,lastSuccess:now-storageAge,plannedLogicalWritesPerDay:720,indexedWriteEstimatePerDay:7920},feed:{total:1},selectedToday:1,dailyCap:4,revision:'test'},signals:[s],review:[],context:{selectionImpact:'Context gates',onchain:{available:false,reason:'Unavailable'},economicCalendar:{events:[],sources:[],reason:'Schedules loaded'},tokenOnchain:{assets:{BTCUSDT:{flowAvailable:true,inflowUsd:100,outflowUsd:90,netInflowUsd:10,activeAddresses:1000,periodEnd:now}},reason:'Daily provider flows'},feeds:[]}};
 configure(sample);
 const sandbox=vm.createContext({sample,Date:class extends Date{static now(){return now;}},document:{documentElement:{dataset:{theme:'dark'}},getElementById:id=>elements[id]},fetch:async()=>({ok:true,json:async()=>sample}),setInterval(){},URL,console});
 vm.runInContext(source,sandbox);vm.runInContext('data=sample;lastResponse=Date.now();render()',sandbox);
 elements.clickDetail=key=>elements.health.handlers.click({target:{closest:()=>({dataset:{detail:key}})}});
 elements.clickMarket=symbol=>elements['market-cards'].handlers.click({target:{closest:selector=>selector==='a'?null:({dataset:{openMarket:symbol}})}});
 return elements;
}
test('final card renders exact entry/SL/three TPs, strategy, context and expiry safely',()=>{const e=dashboard();assert.match(e.signals.innerHTML,/100.15/);assert.match(e.signals.innerHTML,/98.05/);assert.match(e.signals.innerHTML,/102.25/);assert.match(e.signals.innerHTML,/104.35/);assert.match(e.signals.innerHTML,/106.45/);assert.match(e.signals.innerHTML,/SL/);assert.match(e.signals.innerHTML,/TREND_BREAKOUT/);assert.match(e.signals.innerHTML,/Entry review available/);assert.match(e.signals.innerHTML,/Valid until/);assert.match(e.signals.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(e.signals.innerHTML,/<script>bad/);assert.match(e.context.innerHTML,/Upcoming US economic/);});
test('non-actionable archived card keeps its evidence without inviting a new entry',()=>{const e=dashboard(false);assert.match(e.signals.innerHTML,/do not chase/);assert.doesNotMatch(e.signals.innerHTML,/Entry review available/);});

test('client-side stale storage and feed overrides an earlier actionable response',()=>{
 const storage=dashboard(true,301000),feed=dashboard(true,0,91000);assert.match(storage.signals.innerHTML,/Persistence unavailable; entry blocked/);assert.match(feed.signals.innerHTML,/Market feed stale; entry blocked/);for(const e of [storage,feed])assert.doesNotMatch(e.signals.innerHTML,/Entry review available/);
});

test('clicking a watchlist card opens blockers and evidence without inventing signal levels',()=>{
 const e=dashboard(true,0,0,sample=>{sample.signals=[];sample.review=[{symbol:'BTCUSDT',eligible:false,reason:'D1/H4/H1 trends disagree'}];});
 assert.match(e['market-cards'].innerHTML,/data-open-market="BTCUSDT"/);e.clickMarket('BTCUSDT');
 assert.equal(e['market-dialog'].open,true);assert.equal(e['market-title'].textContent,'BTCUSDT · Analysis & signal');
 assert.match(e['market-detail'].innerHTML,/trends disagree/);assert.match(e['market-detail'].innerHTML,/No published setup/);assert.match(e['market-detail'].innerHTML,/Net inflow/);assert.doesNotMatch(e['market-detail'].innerHTML,/Entry limit reference/);
 e['market-close'].handlers.click();assert.equal(e['market-dialog'].open,false);
});
test('clicking a saved signal opens its exact levels and preserves stale-data blocking',()=>{
 for(const age of [0,301000]){const e=dashboard(true,age);e.clickMarket('BTCUSDT');assert.match(e['market-detail'].innerHTML,/100.15/);assert.match(e['market-detail'].innerHTML,/TP3/);assert.match(e['market-detail'].innerHTML,age?/Persistence unavailable; entry blocked/:/Entry review available/);}
});
test('uncovered token card exposes missing flows and cannot be presented as entry-ready',()=>{
 const e=dashboard(true,0,0,sample=>{sample.signals=[];sample.health.markets[0].symbol='SOLUSDT';sample.review=[{symbol:'SOLUSDT',eligible:false,reason:'No volume-confirmed breakout or pullback'}];sample.context.tokenOnchain.assets={SOLUSDT:{flowAvailable:false,reason:'No verified public coverage'}};});
 e.clickMarket('SOLUSDT');assert.match(e['market-detail'].innerHTML,/Flow-confirmed tier unavailable/);assert.match(e['market-detail'].innerHTML,/No verified public coverage/);assert.doesNotMatch(e['market-cards'].innerHTML,/Entry review available/);
});

test('technical signal discloses missing flows and cross-venue freshness can independently block entry',()=>{
 const e=dashboard(true,0,0,sample=>{sample.signals[0].coverageTier='TECHNICAL_CONTEXT';sample.signals[0].context.flow=null;sample.signals[0].context.coverageNote='Token exchange flows unavailable';});
 assert.match(e.signals.innerHTML,/TECHNICAL \+ PUBLIC CONTEXT/);assert.match(e.signals.innerHTML,/Token exchange flows UNAVAILABLE/);assert.doesNotMatch(e.signals.innerHTML,/FLOW CONFIRMED/);e.clickMarket('BTCUSDT');assert.match(e['market-detail'].innerHTML,/Entry review available/);
 const blocked=dashboard(true,0,0,sample=>{sample.venueContext.markets.BTCUSDT.at=now-91000;});assert.match(blocked.signals.innerHTML,/Cross-venue price unavailable or conflicting; entry blocked/);assert.doesNotMatch(blocked.signals.innerHTML,/Entry review available/);
});

test('trade journal labels simulated outcomes and scales PnL without changing signal entry gates',()=>{
 const e=dashboard(false,0,0,sample=>{sample.simulationSummary={tp:1,stop:1,open:0,resolved:2,winRate:50,netPnlUsdt:300,timeout:0,unresolved:0,ambiguous:0};sample.signals[0].simulation={status:'TP1',exit:102.25,netPnlUsdt:300,closedAt:now,reason:'TP1 hit; full hypothetical position closed',checkedThrough:now};});
 assert.match(e['simulation-metrics'].innerHTML,/50.0%/);assert.match(e['simulation-trades'].innerHTML,/SIMULATED WIN/);assert.match(e['simulation-trades'].innerHTML,/\+20.00/);assert.match(e['simulation-note'].textContent,/excluded/);assert.doesNotMatch(e.signals.innerHTML,/Entry review available/);
 e.notional.value='15000';e.notional.handlers.input();assert.match(e['simulation-trades'].innerHTML,/\+300.00/);
});
test('live simulation PnL becomes unavailable when quote timestamps age',()=>{
 const e=dashboard(false,0,0,sample=>{sample.signals[0].simulation={status:'OPEN',markPrice:101,markPnlUsdt:100,markAt:now-91000,reason:'Recovery pending'};});assert.match(e['simulation-trades'].innerHTML,/Unavailable/);assert.doesNotMatch(e['simulation-trades'].innerHTML,/\+6.67/);
});

test('summary cards open live details, close and keep simulation caveats explicit',()=>{
 const e=dashboard(false);assert.match(e.health.innerHTML,/data-detail="health:0"/);assert.match(e['simulation-metrics'].innerHTML,/summary and details/);
 e.clickDetail('health:0');assert.equal(e['detail-dialog'].open,true);assert.equal(e['detail-title'].textContent,'Market feeds');assert.match(e['detail-body'].innerHTML,/≤90 seconds/);assert.match(e['detail-body'].innerHTML,/BTCUSDT/);
 e['detail-close'].handlers.click();assert.equal(e['detail-dialog'].open,false);
 e.clickDetail('performance:0');assert.match(e['detail-body'].innerHTML,/not a forecast/);assert.match(e['detail-body'].innerHTML,/excluded/);
 e.clickDetail('trade:x');assert.equal(e['detail-title'].textContent,'BTCUSDT · Trade summary');assert.match(e['detail-body'].innerHTML,/HYPOTHETICAL TRADE/);assert.match(e['detail-body'].innerHTML,/100.15/);assert.doesNotMatch(e['detail-body'].innerHTML,/<script>bad/);
});
test('theme toggle changes its accessible action and is independent of entry availability',()=>{
 const e=dashboard(false);assert.equal(e['theme-toggle']['aria-label'],'Switch to light mode');e['theme-toggle'].handlers.click();assert.equal(e['theme-toggle']['aria-label'],'Switch to dark mode');e['theme-toggle'].handlers.click();assert.equal(e['theme-toggle']['aria-label'],'Switch to light mode');assert.doesNotMatch(e.signals.innerHTML,/Entry review available/);
});
