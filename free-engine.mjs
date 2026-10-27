import {createPushAlerts,readPushBody} from './push-alerts.mjs';
import {compactSignalLedger} from './signal-ledger.mjs';
import {createVenueContext,venueGate} from './free-venue-context.mjs';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createFreeTransport} from './storage/free-transport.mjs';
import {createFreeCheckpoint,CHECKPOINT_MS} from './storage/free-checkpoint.mjs';
import {createContext,contextGate,contextReadiness} from './market-context.mjs';
import {MODEL,closedCandles,candleCoverage,evaluateMtf,selectSetups,freshness,reviewDay,entryState,invalidateEntry} from './mtf-strategy.mjs';

const RELAY=process.env.FREE_MARKET_RELAY_URL;
if(!RELAY) throw new Error('FREE_MARKET_RELAY_URL is required');
const store=createFreeCheckpoint(createFreeTransport());
const context=createContext();
const venueContext=createVenueContext();
const historyAttempts=new Map();
const instruments=new Map();
const pushAlerts=createPushAlerts();
const pushRate=new Map();
const runtime={startedAt:Date.now(),revision:process.env.RAILWAY_GIT_COMMIT_SHA||'local',market:{},errors:[],review:[],lastPoll:null,lastReview:null,lastBook:null,lastTrade:null,recovered:false};
let working={version:1,savedAt:0,symbols:[],histories:{},signals:[]},published=null,lastUniverse=0,busy=false;
const error=e=>{runtime.errors=[{at:Date.now(),message:String(e.message||e).slice(0,300)},...runtime.errors].slice(0,5);};
async function relay(mode,symbols=[],extra={}) {
  const u=new URL(RELAY);u.searchParams.set('mode',mode);if(symbols.length)u.searchParams.set('symbols',symbols.join(','));
  for(const [k,v] of Object.entries(extra))u.searchParams.set(k,String(v));
  const r=await fetch(u,{signal:AbortSignal.timeout(25_000)}),j=await r.json();
  if(!r.ok||!j.ok)throw new Error('Market relay '+(j.error||r.status));return j;
}
async function universe() {
  const j=await relay('bootstrap');
  for(const i of j.info)instruments.set(i.symbol,{tickSize:i.priceFilter?.tickSize});
  const valid=new Set(j.info.filter(i=>i.status==='Trading'&&i.quoteCoin==='USDT'&&i.contractType==='LinearPerpetual'&&['','innovation'].includes(i.symbolType||'')&&!/^(USDC|USDE|DAI|TUSD|FDUSD|USDD|BUSD)USDT$/.test(i.symbol)).map(i=>i.symbol));
  const ranked=j.tickers.filter(t=>valid.has(t.symbol)&&Number(t.turnover24h)>=50_000_000).sort((a,b)=>Number(b.turnover24h)-Number(a.turnover24h)).map(t=>t.symbol);
  // Keep open setups covered even when their asset drops out of the liquid universe.
  const open=working.signals.filter(s=>s.entryValidUntil>Date.now()||s.status==='OPEN').map(s=>s.symbol);
  working.symbols=[...new Set([...open,...['BTCUSDT','ETHUSDT'].filter(s=>ranked.includes(s)),...ranked])].slice(0,20);
  working.histories=Object.fromEntries(Object.entries(working.histories).filter(([s])=>working.symbols.includes(s)));
  lastUniverse=Date.now();
}
async function snapshot() {
  const tickers=[],results=[];
  for(let i=0;i<working.symbols.length;i+=10){const j=await relay('snapshot',working.symbols.slice(i,i+10));tickers.push(...j.tickers);results.push(...j.results);}
  const j={tickers,results},now=Date.now();
  for(const r of j.results||[]) {
    const t=j.tickers.find(t=>t.symbol===r.symbol);
    if(r.error||!t)continue;
    const bid=Number(r.book?.b?.[0]?.[0]),ask=Number(r.book?.a?.[0]?.[0]);
    const oi=(r.oi||[]).map(x=>({t:Number(x.timestamp),v:Number(x.openInterest)})).filter(x=>x.v>0&&Number.isFinite(x.t)).sort((a,b)=>a.t-b.t);
    const latest=oi.at(-1),base=oi.find(x=>latest && latest.t-x.t>=3_000_000);
    const tradeAt=Number(r.trades?.[0]?.time),bookAt=Number(r.book?.ts);
    runtime.market[r.symbol]={symbol:r.symbol,tickSize:instruments.get(r.symbol)?.tickSize,price:Number(t.lastPrice),turnover24h:Number(t.turnover24h),spreadBps:bid>0&&ask>=bid?(ask-bid)/((ask+bid)/2)*10000:null,bookAt,tradeAt,receivedAt:now,fundingRate:t.fundingRate!==''&&t.fundingRate!=null?Number(t.fundingRate):null,oiAt:latest?.t||null,oiChange:base?(latest.v-base.v)/base.v:null};
  }
  runtime.lastPoll=now;
  runtime.lastBook=Math.max(0,...Object.values(runtime.market).map(m=>m.bookAt||0))||null;
  runtime.lastTrade=Math.max(0,...Object.values(runtime.market).map(m=>m.tradeAt||0))||null;
}
async function history() {
  const now=Date.now();let remaining=3;
  for(const symbol of [...working.symbols].sort((a,b)=>(historyAttempts.get(a)||0)-(historyAttempts.get(b)||0))) {
    if(['H1','H4','D1'].every(tf=>candleCoverage(working.histories[symbol]?.[tf],tf,now)))continue;
    if(Date.now()-(historyAttempts.get(symbol)||0)<60000)continue;
    if(!remaining--)break;historyAttempts.set(symbol,Date.now());
    try {const j=await relay('history',[symbol]);working.histories[symbol]=Object.fromEntries(['H1','H4','D1'].map(tf=>[tf,closedCandles(j.histories[tf],tf,now)]));}catch(e){error(e);}
  }
}
function status() {
  const now=Date.now(),p=store.status(),markets=working.symbols.map(s=>({...runtime.market[s],symbol:s,...freshness(runtime.market[s],now)}));
  const venue=venueContext.status(),venueOk=venue.available&&venue.fetchedAt<=now+5000&&now-venue.fetchedAt<=90000;
  const fresh=markets.filter(m=>m.fresh).length,storageOk=p.recovered&&!p.error&&p.lastSuccess>0&&now-p.lastSuccess<300_000,contextHealth=contextReadiness(context.status(),now,{allowTechnicalSignals:true});
  return {ok:storageOk&&contextHealth.ok&&venueOk&&fresh>=Math.min(5,working.symbols.length)&&working.symbols.length>=5,context:contextHealth,venue:{ok:venueOk,source:"OKX",fetchedAt:venue.fetchedAt,reason:venue.reason},signalPolicy:{strategyFamilies:['DAILY_ALIGNED','H4_LED'],technicalSignalsEnabled:true,flowConfirmedSymbols:contextHealth.flowSymbols,requiredVenue:"OKX",referenceVenue:"Bybit"},profile:'free_mtf',model:MODEL,paperOnly:false,manualSignalsOnly:true,paperMonitoringEnabled:false,simulationEnabled:false,executionEnabled:false,revision:runtime.revision,startedAt:runtime.startedAt,lastBook:runtime.lastBook,lastTrade:runtime.lastTrade,lastPoll:runtime.lastPoll,lastReview:runtime.lastReview,storage:{...p,ok:storageOk,ageMs:p.lastSuccess?now-p.lastSuccess:null,plannedLogicalWritesPerDay:720,indexedWriteEstimatePerDay:7920,estimateNote:'Conservative 11 D1 rows per document save; other services share the account allowance'},feed:{fresh,total:markets.length},markets,errors:runtime.errors,evidence:{status:'RULE_BASED_UNVALIDATED',expectedPnlAvailable:false,reason:'Rule score is not a win probability; forward outcomes and complete funding costs required'},day:reviewDay(now),dailyCap:5,publicationPolicy:{dailyCap:5,batchCap:5,globalCooldownMs:0,duplicateGuard:'one publication per symbol/closed-H1 trigger',positionGuard:'one active simulated position per symbol'},selectedToday:(published?.signals||[]).filter(s=>reviewDay(s.createdAt)===reviewDay(now)).length+(published?.archivedPublicationsByDay?.[reviewDay(now)]||0)};
}
async function cycle() {
  if(busy)return;busy=true;
  try {
    if(!runtime.recovered) {
      const saved=await store.load();if(saved)working=saved;published=structuredClone(working);runtime.recovered=true;historyAttempts.clear();
    }
    // Commit device changes even if the market source is temporarily unavailable.
    if(pushAlerts.needsSave(working)||!published?.pushAlerts){
      const prepared=pushAlerts.prepare(working);
      const saved=await store.save(compactSignalLedger({...prepared.value,histories:{}},Date.now()));
      if(saved){working={...saved,histories:working.histories};published=structuredClone(saved);prepared.ack();}
    }
    if(!working.symbols.length||Date.now()-lastUniverse>6*3_600_000)await universe();
    // Feed ingestion never waits for storage writes; both have independent freshness.
    await snapshot();
    const beforeHistory=Date.now();
    await history();
    // Refresh after a slow bootstrap to avoid ranking against an aged book.
    if(Date.now()-beforeHistory>10_000)await snapshot();
    void context.refresh(working.symbols).catch(error);
    void venueContext.refresh().catch(error);
    const now=Date.now();
    const currentContext=context.status(),currentVenue=venueContext.status();
    runtime.review=working.symbols.map(s=>{
      const reviews=['DAILY_ALIGNED','H4_LED'].map(family=>venueGate(contextGate(evaluateMtf(s,working.histories[s],runtime.market[s],working.histories.BTCUSDT,now,{family}),currentContext,now,{allowTechnicalSignals:true}),runtime.market[s],currentVenue,now));
      const chosen=reviews.find(r=>r.eligible)||reviews[1];
      return {...chosen,strategyReviews:reviews.map(({family,eligible,reason,strategy,direction,score})=>({family,eligible,reason,strategy,direction,score}))};
    });
    runtime.lastReview=now;
    working.signals=working.signals.map(s=>invalidateEntry(s,runtime.market[s.symbol],now));
    const candidates=selectSetups(runtime.review,working.signals,now,{triggerWatermarks:working.triggerWatermarks,archivedPublicationsByDay:working.archivedPublicationsByDay});
    const next={...working,signals:[...working.signals,...candidates]};
    // Alerts and signals become visible only after the same checkpoint commits.
    const prepared=pushAlerts.prepare(next,candidates);
    const saved=await store.save(compactSignalLedger({...prepared.value,histories:{}},now));
    if(saved){working={...saved,histories:working.histories};published=structuredClone(saved);prepared.ack();}
    void pushAlerts.deliver(published,()=>displayedSignals()).catch(()=>{});
  } catch(e){error(e);if(e.conflict)runtime.recovered=false;}finally{busy=false;}
}
const routes={'/':'free.html','/free-app.js':'free-app.js','/free.css':'free.css','/push-app.js':'push-app.js','/sw.js':'sw.js','/manifest.webmanifest':'manifest.webmanifest','/app-icon.svg':'app-icon.svg'};
function displayedSignals(){const h=status(),now=Date.now(),c=context.status(),v=venueContext.status();return (published?.signals||[]).map(saved=>{const pending=working.signals.find(x=>x.id===saved.id);const s=invalidateEntry(pending?.status==='INVALIDATED'?{...saved,status:pending.status,invalidationReason:pending.invalidationReason}:saved,runtime.market[saved.symbol],now);const gate=venueGate(contextGate({...s,eligible:true},c,now,{allowTechnicalSignals:s.coverageTier==='TECHNICAL_CONTEXT'}),runtime.market[s.symbol],v,now),entryStatus=entryState(s,runtime.market[s.symbol],now,h.ok&&gate.eligible&&!!s.context);return {...s,entryStatus,contextBlock:gate.eligible?null:gate.reason};});}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const json=(data,code=200)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
  if(url.pathname.startsWith('/api/push/')){
    const token=req.headers.authorization?.replace(/^Bearer /,'');
    if(req.method==='GET'&&url.pathname==='/api/push/config')return json({available:!!published?.pushAlerts,publicKey:published?.pushAlerts?.publicKey||null});
    if(req.method==='GET'&&url.pathname==='/api/push/status')return json(pushAlerts.deviceStatus(published,token));
    if(req.method!=='POST')return json({error:'method_not_allowed'},405);
    if(req.headers.origin!=='https://crypto-engine-production-production.up.railway.app')return json({error:'same_origin_required'},403);
    if(!published?.pushAlerts)return json({error:'Notification storage is warming; try again shortly'},503);
    const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',').at(-1).trim(),now=Date.now();
    for(const[k,v]of pushRate)if(now-v.at>60000)pushRate.delete(k);
    const rate=pushRate.get(ip)||{at:now,n:0};
    if(rate.n>=6||pushRate.size>=1000)return json({error:'Please wait a minute before retrying'},429);
    rate.n++;pushRate.set(ip,rate);
    try{
      if(url.pathname==='/api/push/subscribe'){const body=await readPushBody(req);return json(pushAlerts.register(published,body.subscription,token),202);}
      if(url.pathname==='/api/push/unsubscribe'){pushAlerts.remove(published,token);return json({pending:true},202);}
      return json({error:'not_found'},404);
    }catch{return json({error:'Invalid or unsupported subscription; reset this device subscription and retry'},400);}
  }
  if(req.method!=='GET')return json({error:'read_only'},405);
  if(url.pathname==='/api/health'||url.pathname==='/api/ready'){const h=status();return json(h,h.ok?200:503);}
  // Explicit liveness is distinct from readiness: a quota-blocked engine remains
  // available to explain its state and recover, without calling itself healthy.
  if(url.pathname==='/api/live')return json({ok:true,profile:'free_mtf',ready:status().ok});
  if(url.pathname==='/api/dashboard')return json({health:status(),signals:displayedSignals(),context:context.status(),venueContext:venueContext.status(),review:runtime.review.map(({symbol,eligible,technicalEligible,reason,score,strategy,coverageTier,venue,analysis,family,strategyReviews})=>({symbol,eligible,technicalEligible,reason,score,strategy,coverageTier,venue,analysis,family,strategyReviews}))});
  if(url.pathname==='/api/signals')return json(displayedSignals());
  if(url.pathname==='/api/paper-trades')return json({enabled:false,simulated:false,trades:[],summary:null,reason:'Paper trading disabled; manual signals only'});
  if(url.pathname==='/api/market')return json(status().markets);
  if(url.pathname==='/api/pre-rally')return json({enabled:false,reason:'Free profile focuses on liquid MTF setups'});
  const file=routes[url.pathname];if(!file)return json({error:'not_found'},404);
  try {res.writeHead(200,{'content-type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.webmanifest')?'application/manifest+json':file.endsWith('.svg')?'image/svg+xml':'text/html','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(await readFile(new URL('./public/'+file,import.meta.url)));}catch{res.end('Unavailable');}
});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>{console.log('Manual MTF signal server started; paper monitoring disabled; execution disabled');cycle();setInterval(cycle,30_000);});
