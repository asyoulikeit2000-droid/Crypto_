import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVenueTickers,venueGate,createVenueContext} from '../free-venue-context.mjs';
const now=Date.UTC(2026,9,10,18),row={instId:'SOL-USDT-SWAP',last:'100',ts:String(now)},candidate={eligible:true,symbol:'SOLUSDT',score:90,reason:'Qualified strategy'};
const value=()=>({available:true,fetchedAt:now,markets:parseVenueTickers({code:'0',data:[row]},now)});
test('OKX mapping only accepts exact current USDT perpetuals, never guessed aliases or multipliers',()=>{
 const m=parseVenueTickers({code:'0',data:[row,{...row,instId:'SOL-USD-SWAP'},{...row,instId:'SOL-USDT-261225'},{...row,instId:'ETH-USDT-SWAP',ts:String(now-91000)},{...row,instId:'BTC-USDT-SWAP',ts:String(now+6000)}]},now);
 assert.deepEqual(Object.keys(m),['SOLUSDT']);assert.throws(()=>parseVenueTickers({code:'1',data:[row]},now));assert.throws(()=>parseVenueTickers({code:'0',data:[row,row]},now),/Ambiguous/);
});
test('cross-venue gate corroborates price without score inflation; stale, missing or conflicting evidence blocks',()=>{
 const r=venueGate(candidate,{price:100.1},value(),now);assert(r.eligible);assert.equal(r.score,90);assert(Math.abs(r.venue.deviationBps-10)<1e-8);
 for(const v of [{available:false}, {...value(),fetchedAt:now-91000},{...value(),markets:{}},{...value(),markets:{SOLUSDT:{price:100,at:now+6000}}},{...value(),markets:{SOLUSDT:{price:100}}},{...value(),fetchedAt:'invalid'}])assert.equal(venueGate(candidate,{price:100},v,now).eligible,false);
 assert.equal(venueGate(candidate,{price:101},value(),now).eligible,false);assert.equal(venueGate(candidate,{price:null},value(),now).eligible,false);
 const rejected={...candidate,eligible:false,reason:'No trigger'};assert.equal(venueGate(rejected,null,null,now),rejected);
});
test('public quote refresh is bounded, reports failures and does not retain stale prices as available',async()=>{
 let stamp=now,calls=0,fail=false;const c=createVenueContext(async()=>{calls++;return {ok:!fail,status:503,json:async()=>({code:'0',data:[{...row,ts:String(stamp)}]})};},()=>stamp);
 await c.refresh();assert(c.status().available);await c.refresh();assert.equal(calls,1);stamp+=60000;fail=true;await c.refresh();assert.equal(c.status().available,false);assert.deepEqual(c.status().markets,{});await c.refresh();assert.equal(calls,2);
});
