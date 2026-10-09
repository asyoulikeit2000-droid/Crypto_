import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createFreeTransport} from './storage/free-transport.mjs';
import {createFreeCheckpoint,CHECKPOINT_MS} from './storage/free-checkpoint.mjs';
import {createContext} from './market-context.mjs';
import {MODEL,closedCandles,candleCoverage,evaluateMtf,selectSetups,freshness,reviewDay} from './mtf-strategy.mjs';

const RELAY=process.env.FREE_MARKET_RELAY_URL;
if(!RELAY) throw new Error('FREE_MARKET_RELAY_URL is required');
const store=createFreeCheckpoint(createFreeTransport());
const context=createContext();
const historyAttempts=new Map();
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
  const valid=new Set(j.info.filter(i=>i.status==='Trading'&&i.quoteCoin==='USDT'&&i.contractType==='LinearPerpetual'&&['','innovation'].includes(i.symbolType||'')&&!/^(USDC|USDE|DAI|TUSD|FDUSD|USDD|BUSD)USDT$/.test(i.symbol)).map(i=>i.symbol));
  const ranked=j.tickers.filter(t=>valid.has(t.symbol)&&Number(t.turnover24h)>=50_000_000).sort((a,b)=>Number(b.turnover24h)-Number(a.turnover24h)).map(t=>t.symbol);
  // Keep open setups covered even when their asset drops out of the liquid universe.
  const open=working.signals.filter(s=>s.entryValidUntil>Date.now()).map(s=>s.symbol);
  working.symbols=[...new Set([...open,...['BTCUSDT','ETHUSDT'].filter(s=>ranked.includes(s)),...ranked])].slice(0,30);
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
    runtime.market[r.symbol]={symbol:r.symbol,price:Number(t.lastPrice),turnover24h:Number(t.turnover24h),spreadBps:bid>0&&ask>=bid?(ask-bid)/((ask+bid)/2)*10000:null,bookAt,tradeAt,receivedAt:now,fundingRate:t.fundingRate!==''&&t.fundingRate!=null?Number(t.fundingRate):null,oiAt:latest?.t||null,oiChange:base?(latest.v-base.v)/base.v:null};
  }
  runtime.lastPoll=now;
  runtime.lastBook=Math.max(0,...Object.values(runtime.market).map(m=>m.bookAt||0))||null;
  runtime.lastTrade=Math.max(0,...Object.values(runtime.market).map(m=>m.tradeAt||0))||null;
}
async function history() {
  const now=Date.now();let remaining=3;
  for(const symbol of working.symbols) {
    if(['H1','H4','D1'].every(tf=>candleCoverage(working.histories[symbol]?.[tf],tf,now)))continue;
    if(Date.now()-(historyAttempts.get(symbol)||0)<300000)continue;
    if(!remaining--)break;historyAttempts.set(symbol,Date.now());
    try {const j=await relay('history',[symbol]);working.histories[symbol]=Object.fromEntries(['H1','H4','D1'].map(tf=>[tf,closedCandles(j.histories[tf],tf,now)]));}catch(e){error(e);}
  }
}
function status() {
  const now=Date.now(),p=store.status(),markets=working.symbols.map(s=>({...runtime.market[s],symbol:s,...freshness(runtime.market[s],now)}));
  const fresh=markets.filter(m=>m.fresh).length,storageOk=p.recovered&&!p.error&&p.lastSuccess>0&&now-p.lastSuccess<300_000;
  return {ok:storageOk&&fresh>=Math.min(5,working.symbols.length)&&working.symbols.length>=5,profile:'free_mtf',model:MODEL,paperOnly:false,manualSignalsOnly:true,paperMonitoringEnabled:false,executionEnabled:false,revision:runtime.revision,startedAt:runtime.startedAt,lastBook:runtime.lastBook,lastTrade:runtime.lastTrade,lastPoll:runtime.lastPoll,lastReview:runtime.lastReview,storage:{...p,ok:storageOk,ageMs:p.lastSuccess?now-p.lastSuccess:null,plannedLogicalWritesPerDay:720,indexedWriteEstimatePerDay:7920,estimateNote:'Conservative 11 D1 rows per document save; account also serves the separate bot'},feed:{fresh,total:markets.length},markets,errors:runtime.errors,evidence:{status:'RULE_BASED_UNVALIDATED',expectedPnlAvailable:false,reason:'Rule score is not a win probability; forward outcomes and complete funding costs required'},day:reviewDay(now),dailyCap:4,selectedToday:(published?.signals||[]).filter(s=>reviewDay(s.createdAt)===reviewDay(now)).length};
}
async function cycle() {
  if(busy)return;busy=true;
  try {
    if(!runtime.recovered) {
      const saved=await store.load();if(saved)working=saved;published=structuredClone(working);runtime.recovered=true;historyAttempts.clear();
    }
    if(!working.symbols.length||Date.now()-lastUniverse>6*3_600_000)await universe();
    // Feed ingestion never waits for storage writes; both have independent freshness.
    await snapshot();
    const beforeHistory=Date.now();
    await history();
    // Refresh after a slow bootstrap to avoid ranking against an aged book.
    if(Date.now()-beforeHistory>10_000)await snapshot();
    context.refresh();
    const now=Date.now();
    runtime.review=working.symbols.map(s=>evaluateMtf(s,working.histories[s],runtime.market[s],working.histories.BTCUSDT,now));
    runtime.lastReview=now;
    working.signals=working.signals.filter(s=>now-s.createdAt<=7*86_400_000);
    const candidates=selectSetups(runtime.review,working.signals,now);
    const next={...working,signals:[...working.signals,...candidates]};
    // Selection is visible only after the same checkpoint commits its daily cap.
    const saved=await store.save({...next,histories:{}});
    if(saved){working={...saved,histories:working.histories};published=structuredClone(saved);}
  } catch(e){error(e);if(e.conflict)runtime.recovered=false;}finally{busy=false;}
}
const routes={'/':'free.html','/free-app.js':'free-app.js','/free.css':'free.css'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const json=(data,code=200)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
  if(req.method!=='GET')return json({error:'read_only'},405);
  if(url.pathname==='/api/health'||url.pathname==='/api/ready'){const h=status();return json(h,h.ok?200:503);}
  // Explicit liveness is distinct from readiness: a quota-blocked engine remains
  // available to explain its state and recover, without calling itself healthy.
  if(url.pathname==='/api/live')return json({ok:true,profile:'free_mtf',ready:status().ok});
  if(url.pathname==='/api/dashboard')return json({health:status(),signals:published?.signals||[],context:context.status(),review:runtime.review.map(({symbol,eligible,reason,score})=>({symbol,eligible,reason,score}))});
  if(url.pathname==='/api/signals')return json(published?.signals||[]);
  if(url.pathname==='/api/paper-trades')return json({enabled:false,reason:'Paper-trade monitoring disabled'});
  if(url.pathname==='/api/market')return json(status().markets);
  if(url.pathname==='/api/pre-rally')return json({enabled:false,reason:'Free profile focuses on liquid MTF setups'});
  const file=routes[url.pathname];if(!file)return json({error:'not_found'},404);
  try {res.writeHead(200,{'content-type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(await readFile(new URL('./public/'+file,import.meta.url)));}catch{res.end('Unavailable');}
});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>{console.log('Manual MTF signal server started; paper monitoring and execution disabled');cycle();setInterval(cycle,30_000);});
