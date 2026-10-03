import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('a successful read cannot clear failed writes or manufacture persistence readiness',async()=>{
  const src=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
  const now=Date.parse('2026-10-03T17:00:00Z'),iso=()=>new Date(now).toISOString();
  const state={ready:true,assets:Array(5).fill({}),lastUniverseRefresh:iso(),lastTrade:iso(),lastBook:iso(),
    lastStorageSuccessAt:iso(),lastStorageWriteSuccessAt:iso(),storageWriteFailed:false};
  let fail=false;
  class Clock extends Date{static now(){return now;}}
  const c=vm.createContext({state,Date:Clock,iso,requireConfigured:()=>{},primaryStore:{db:async()=>{if(fail)throw new Error('daily quota');return [];}}});
  vm.runInContext(src.slice(src.indexOf('async function db('),src.indexOf('async function insertRows(')),c);
  vm.runInContext(src.slice(src.indexOf('function healthReadiness()'),src.indexOf('async function healthPayload()')),c);
  assert.equal(vm.runInContext('healthReadiness().ready',c),true);
  fail=true;await assert.rejects(vm.runInContext('db("signals","POST")',c));
  fail=false;await vm.runInContext('db("signals","GET")',c);
  assert.equal(vm.runInContext('healthReadiness().storageLive',c),false);
  assert.equal(vm.runInContext('healthReadiness().ready',c),false);
  await vm.runInContext('db("signals","POST")',c);
  assert.equal(vm.runInContext('healthReadiness().ready',c),true);
  state.lastStorageWriteSuccessAt=new Date(now-61000).toISOString();
  assert.equal(vm.runInContext('healthReadiness().ready',c),false);
});

test('known daily D1 quota errors are not retried and pause further writes until reset',async(t)=>{
  process.env.CLOUDFLARE_D1_RELAY_URL='https://d1.example.invalid';
  process.env.CLOUDFLARE_D1_RELAY_TOKEN='test';
  const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});
  let calls=0;
  globalThis.fetch=async(_url,init)=>{
    calls++;const body=JSON.parse(init.body);
    if(body.method==='GET')return new Response(JSON.stringify({ok:true,rows:[]}),{status:200});
    return new Response(JSON.stringify({error:"Your account has exceeded D1's free tier daily row write limit"}),{status:500});
  };
  const {createD1Compat}=await import('../storage/d1-store.mjs?quota-test');
  const store=createD1Compat();
  await assert.rejects(store.db('signals','POST',{},{}),/daily row write limit/);
  assert.equal(calls,1);
  await assert.rejects(store.db('signals','POST',{},{}),/writes paused/);
  assert.equal(calls,1);
  assert.deepEqual(await store.db('signals','GET'),[]);assert.equal(calls,2);
});
