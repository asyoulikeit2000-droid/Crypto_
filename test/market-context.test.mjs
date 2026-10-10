import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRss,stablecoinContext,createContext,easternTime,parseCalendar,parseFomc,tokenEvidence,contextGate} from '../market-context.mjs';
const DAY=86400000,HOUR=3600000,now=Date.UTC(2026,9,9,12);
const rss=(title='Bitcoin and oil markets',url='https://example.com/a',at=now-HOUR)=>`<item><title>${title}</title><link>${url}</link><pubDate>${new Date(at).toUTCString()}</pubDate></item>`;
const rows=(asset='btc')=>Array.from({length:8},(_,i)=>({asset,time:new Date(Math.floor(now/DAY)*DAY-(8-i)*DAY).toISOString(),FlowInExUSD:'100',FlowOutExUSD:'110',AdrActCnt:'1000'}));
const candidate={eligible:true,symbol:'BTCUSDT',direction:'LONG',entryValidUntil:now+HOUR,reason:'Technical setup',score:85};
const valid=()=>({updatedAt:now,feeds:['cryptoNews','globalNews'].map(id=>({id,available:true,items:[{title:'Bitcoin and oil markets',url:'https://example.com',publishedAt:now-HOUR}]})),economicCalendar:{available:true,events:[{title:'CPI',at:now+5*HOUR,highImpact:true,source:'BLS'}]},onchain:{available:true,observedAt:now-12*HOUR,change7dPct:0},tokenOnchain:{assets:{BTCUSDT:tokenEvidence(rows(),'btc',now)}}});
const ics=(date='20261020T083000',tz='TZID=US-Eastern')=>`BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;${tz}:${date}\nSUMMARY:Consumer Price Index\nEND:VEVENT\nEND:VCALENDAR`;
test('RSS rejects unsafe/future links and deduplicates headlines',()=>{assert.deepEqual(parseRss(rss('A &amp; B')+rss('A &amp; B')+rss('Bad','javascript:alert(1)')+rss('Future','https://example.com/f',now+2*HOUR),now).map(x=>x.title),['A & B']);});
test('global stablecoin supply is fresh and does not claim token flows',()=>{const row=(at,usd)=>({date:at/1000,totalCirculatingUSD:{peggedUSD:usd}}),c=stablecoinContext([row(now-8*DAY,100),row(now-DAY,110)],now);assert(Math.abs(c.change7dPct-10)<1e-8);assert.match(c.scope,/not asset-specific/);assert.throws(()=>stablecoinContext([row(now-10*DAY,110)],now),/stale|incomplete/);});
test('calendars convert Eastern DST correctly, unfold lines and reject unsupported timezones',()=>{
 assert.equal(easternTime(2026,10,14,8,30),Date.UTC(2026,9,14,12,30));assert.equal(easternTime(2026,11,6,8,30),Date.UTC(2026,10,6,13,30));
 const e=parseCalendar(ics().replace('Consumer Price Index','Consumer Price \n Index'),'BLS','https://www.bls.gov',now)[0];assert.equal(e.at,Date.UTC(2026,9,20,12,30));assert(e.highImpact);assert.equal(e.consensus,null);
 assert.throws(()=>parseCalendar(ics('20261014T083000','TZID=Europe/London'),'BLS','https://example.com',now),/timezone/);
 assert.throws(()=>parseCalendar(ics('20250114T083000'),'BLS','https://example.com',now),/future coverage/);
});
test('FOMC verified dates retain time assumption and block both meeting days',()=>{
 const html='2026 FOMC Meetings<div class="fomc-meeting__month"><strong>October</strong></div><div class="fomc-meeting__date">27-28</div>2025 FOMC Meetings';
 const e=parseFomc(html,now)[0];assert.equal(e.at,Date.UTC(2026,9,28,18));assert.equal(e.blackoutStart,Date.UTC(2026,9,27,4));assert.equal(e.blackoutEnd,Date.UTC(2026,9,29,4));assert.match(e.timing,/assumed/);
});
test('token flows require eight continuous closed UTC daily periods and explicit metrics',()=>{
 const e=tokenEvidence(rows(),'btc',now);assert(e.flowAvailable);assert.equal(e.netInflowUsd,-10);assert.equal(e.activeAddresses,1000);
 assert.equal(tokenEvidence(rows().map(x=>({...x,FlowInExUSD:null})),'btc',now).flowAvailable,false);
 assert.equal(tokenEvidence(rows().slice(1),'btc',now).flowAvailable,false);
 assert.equal(tokenEvidence(rows().map(x=>({...x,time:new Date(Date.parse(x.time)-10*DAY).toISOString()})),'btc',now).flowAvailable,false);
 const future={...rows().at(-1),time:new Date(Math.floor(now/DAY)*DAY).toISOString(),FlowInExUSD:'999999'};assert.equal(tokenEvidence([...rows(),future],'btc',now).inflowUsd,100);
});
test('context gate passes complete evidence without inflating technical score',()=>{const r=contextGate(candidate,valid(),now);assert(r.eligible);assert.equal(r.score,85);assert(r.context.flow.flowAvailable);assert.equal(r.context.consensusAvailable,false);});
test('missing, stale and adverse context veto both long and short candidates',()=>{
 for(const change of [v=>{v.updatedAt=now-3*HOUR;},v=>{v.economicCalendar.available=false;},v=>{v.feeds[0].available=false;},v=>{delete v.tokenOnchain.assets.BTCUSDT;},v=>{v.tokenOnchain.assets.BTCUSDT.periodEnd=now-40*HOUR;},v=>{v.tokenOnchain.assets.BTCUSDT.netFlowRatio=NaN;},v=>{v.tokenOnchain.assets.BTCUSDT.netFlowRatio=.3;},v=>{v.tokenOnchain.assets.BTCUSDT.activityChangePct=-50;},v=>{v.onchain.change7dPct=-2;}]){const v=valid();change(v);assert.equal(contextGate(candidate,v,now).eligible,false);}
 const v=valid();v.tokenOnchain.assets.BTCUSDT.netFlowRatio=-.3;assert.equal(contextGate({...candidate,direction:'SHORT'},v,now).eligible,false);
});
test('event blackout and headline risks veto, nearby future event shortens entry window',()=>{
 let v=valid();v.economicCalendar.events[0].at=now+30*60000;assert.match(contextGate(candidate,v,now).reason,/blackout/);
 v=valid();v.feeds[0].items[0].title='Bitcoin exchange withdrawals halted after hack';assert.match(contextGate(candidate,v,now).reason,/Headline risk/);
 v=valid();v.economicCalendar.events[0].at=now+90*60000;assert.equal(contextGate(candidate,v,now).entryValidUntil,now+30*60000);
});
test('provider failures are visible; failed refresh is bounded to fifteen-minute retries',async()=>{let calls=0;const c=createContext(async()=>{calls++;throw Error('provider unavailable');},()=>now);await c.refresh();assert.equal(calls,9);assert(c.status().feeds.every(f=>!f.available));assert.equal(c.status().economicCalendar.available,false);assert.equal(c.status().tokenOnchain.available,false);await c.refresh();assert.equal(calls,9);});
test('complete provider refresh verifies coverage, batches metrics, and bounds healthy hourly polling',async()=>{
 let calls=0,stamp=now;
 const catalog=['btc','eth','xrp'].map(asset=>({asset,metrics:(asset==='xrp'?['AdrActCnt']:['AdrActCnt','FlowInExUSD','FlowOutExUSD']).map(metric=>({metric,frequencies:[{frequency:'1d',community:true}]}))}));
 const fetcher=async url=>{calls++;let data;
  if(url.includes('catalog-v2'))data=JSON.stringify({data:catalog});
  else if(url.includes('timeseries')){const u=new URL(url);data=JSON.stringify({data:u.searchParams.get('assets').split(',').flatMap(asset=>rows(asset).map(r=>asset==='xrp'?{asset,time:r.time,AdrActCnt:r.AdrActCnt}:r))});}
  else if(url.includes('stablecoins.llama'))data=JSON.stringify([{date:(now-8*DAY)/1000,totalCirculatingUSD:{peggedUSD:100}},{date:(now-DAY)/1000,totalCirculatingUSD:{peggedUSD:101}}]);
  else if(url.includes('fomccalendars'))data='2026 FOMC Meetings<div class="fomc-meeting__month"><strong>October</strong></div><div class="fomc-meeting__date">27-28</div>2025 FOMC Meetings';
  else if(url.endsWith('.ics'))data=ics();
  else data=rss();
  return {ok:true,text:async()=>data,json:async()=>JSON.parse(data)};
 };
 const c=createContext(fetcher,()=>stamp);await c.refresh(['BTCUSDT','ETHUSDT','XRPUSDT','SOLUSDT']);const v=c.status();assert(v.economicCalendar.available);assert.deepEqual(v.tokenOnchain.flowSymbols,['BTCUSDT','ETHUSDT']);assert.equal(v.tokenOnchain.assets.XRPUSDT.flowAvailable,false);assert(v.tokenOnchain.assets.XRPUSDT.available);assert.equal(v.tokenOnchain.assets.SOLUSDT.available,false);assert(contextGate(candidate,v,now).eligible);assert.equal(contextGate({...candidate,symbol:'XRPUSDT'},v,now).eligible,false);assert.equal(calls,11);
 await c.refresh(['BTCUSDT']);assert.equal(calls,11);stamp+=HOUR;await c.refresh(['BTCUSDT']);assert.equal(calls,20);
});
test('important malformed timestamps and calendars without major future events fail closed',()=>{
 assert.throws(()=>parseCalendar(ics('20261320T083000'),'BLS','https://example.com',now),/Invalid event/);
 assert.throws(()=>parseCalendar(ics().replace('DTSTART;TZID=US-Eastern:20261020T083000','DTSTART;VALUE=DATE:20261020'),'BLS','https://example.com',now),/Unrecognized/);
 assert.throws(()=>parseCalendar(ics().replace('Consumer Price Index','Minor survey'),'BLS','https://example.com',now),/future coverage/);
});

test('explicit technical tier permits unavailable flows without relabelling them as verified',()=>{
 const v=valid();delete v.tokenOnchain.assets.BTCUSDT;
 assert.equal(contextGate(candidate,v,now).eligible,false);
 const r=contextGate(candidate,v,now,{allowTechnicalSignals:true});assert(r.eligible);assert.equal(r.coverageTier,'TECHNICAL_CONTEXT');assert.equal(r.context.flow,null);assert.equal(r.context.flowStatus,'UNAVAILABLE');assert.equal(r.score,candidate.score);assert.match(r.reason,/technical tier only/);
 const full=contextGate(candidate,valid(),now,{allowTechnicalSignals:true});assert(full.eligible);assert.equal(full.coverageTier,'FLOW_CONFIRMED');
});
test('technical tier never bypasses adverse or stale reported flows, news, calendars or liquidity',()=>{
 for(const change of [v=>{v.tokenOnchain.assets.BTCUSDT.periodEnd=now-40*HOUR;},v=>{v.tokenOnchain.assets.BTCUSDT.netFlowRatio=.3;},v=>{v.economicCalendar.available=false;},v=>{v.feeds[0].available=false;},v=>{v.onchain.available=false;}]){const v=valid();change(v);assert.equal(contextGate(candidate,v,now,{allowTechnicalSignals:true}).eligible,false);}
 const v=valid();delete v.tokenOnchain.assets.BTCUSDT;v.economicCalendar.events[0].at=now;assert.match(contextGate(candidate,v,now,{allowTechnicalSignals:true}).reason,/blackout/);
});
