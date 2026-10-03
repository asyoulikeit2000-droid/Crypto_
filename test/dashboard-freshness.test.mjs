import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function dashboard(){
  let now=Date.parse('2026-10-03T16:30:00Z');
  const nodes=new Map();
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context=vm.createContext({Date:Clock,document:{hidden:false,querySelector(s){if(!nodes.has(s))nodes.set(s,{style:{},classList:{toggle(){}},textContent:'',innerHTML:''});return nodes.get(s)},querySelectorAll(){return []}},window:{scrollTo(){}},setInterval(){},fetch:()=>new Promise(()=>{})});
  vm.runInContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),context);
  const run=code=>vm.runInContext(code,context);
  run(`D={health:{ready:true,storageLive:true,lastTrade:new Date().toISOString(),lastBook:new Date().toISOString()}};dashboardFetchedAt=new Date().toISOString();render()`);
  return {context,nodes,run,advance(ms){now+=ms;}};
}

test('LIVE requires current trades, books, database and readiness',()=>{
  for(const mutation of ['D.health.lastBook=null','D.health.storageLive=false','D.health.ready=false','D.health.killSwitch=true']){
    const d=dashboard();assert.equal(d.nodes.get('#hero').textContent,'LIVE');d.run(mutation+';render()');assert.notEqual(d.nodes.get('#hero').textContent,'LIVE');
  }
});
test('market refresh cannot hide a failed dashboard request or advance fetched time',async()=>{
  const d=dashboard(),fetched=d.nodes.get('#updated').textContent;
  d.context.fetch=async()=>({ok:false,status:500});await d.run('loadDashboard()');assert.equal(d.nodes.get('#hero').textContent,'ERROR');
  d.context.fetch=async()=>({ok:true,json:async()=>({assets:[]})});await d.run('loadMarket()');assert.equal(d.nodes.get('#hero').textContent,'ERROR');assert.equal(d.nodes.get('#updated').textContent,fetched);
});
test('failed or outdated dashboard makes quality observations unknown',()=>{
  const d=dashboard();d.advance(21000);d.run('D.health.lastTrade=new Date().toISOString();D.health.lastBook=new Date().toISOString();render()');assert.equal(d.nodes.get('#hero').textContent,'STALE');assert.match(d.nodes.get('#quality').innerHTML,/UNKNOWN/);
});
test('invalid or future timestamps are unknown, and signal history displays age',()=>{
  const d=dashboard();for(const value of ['bad','2026-10-04T16:30:00Z',null]){d.context.timestamp=value;assert.equal(d.run('freshness(timestamp).label'),'UNKNOWN');assert.equal(d.run('ago(timestamp)'),'—');}
  assert.match(d.run(`tableSignals([{created_at:'2026-10-03T16:20:00Z',risk_state:'SHADOW'}])`),/10m ago/);
});
test('successful dashboard reload clears request error',async()=>{
  const d=dashboard();d.run(`dashboardError='offline';render()`);d.context.fetch=async()=>({ok:true,json:async()=>({health:{ready:true,storageLive:true,lastTrade:new Date(d.context.Date.now()).toISOString(),lastBook:new Date(d.context.Date.now()).toISOString()}})});await d.run('loadDashboard()');assert.equal(d.nodes.get('#hero').textContent,'LIVE');
});

test('dashboard API exposes storage operations and current readiness without changing signal gate',async()=>{
  const source=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function dashboardPayload()'),source.indexOf('function healthReadiness()'));
  const c=vm.createContext({primaryStore:{backend:"cloudflare_d1"},db:async()=>[],VALIDATION_COHORT_START:'2026-10-01T00:00:00Z',MODEL_ID:'test',FEATURE_VERSION:'test',iso:()=>new Date().toISOString(),publicMarket:()=>[],productionSignalReady:()=>false,modelSignalReady:()=>false,productionSignalGate:()=>({ready:false}),healthReadiness:()=>({ready:false,storageLive:false}),state:{ready:true,assets:[],errors:[],lastStorageSuccessAt:'2026-10-03T16:00:00Z',lastStorageFailureAt:'2026-10-03T16:01:00Z'}});
  vm.runInContext(fn,c);const d=await vm.runInContext('dashboardPayload()',c);
  assert.equal(d.health.ready,false);assert.equal(d.health.status,'degraded');assert.equal(d.health.storageLive,false);assert.equal(d.health.lastStorageSuccessAt,'2026-10-03T16:00:00Z');assert.equal(d.health.lastStorageFailureAt,'2026-10-03T16:01:00Z');assert.equal(d.health.safety.signalReady,false);assert.ok(Number.isFinite(Date.parse(d.generatedAt)));
});
