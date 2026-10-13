import test from 'node:test';
import assert from 'node:assert/strict';
import {createPushAlerts,validateSubscription,ALERT_TTL_MS,MAX_DEVICES,signalPayload} from '../push-alerts.mjs';
const keys=()=>({publicKey:'public',privateKey:'private'});
const sub=(id='device')=>({endpoint:'https://fcm.googleapis.com/fcm/send/'+id,keys:{p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,1)]).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}});
const base=()=>({version:1,signals:[],symbols:[],histories:{},savedAt:0});
const signal=(now,id='one')=>({id,symbol:'BTCUSDT',direction:'LONG',entry:100,stop:95,targets:[110,115,120],createdAt:now,entryValidUntil:now+3600000,status:'OPEN',entryStatus:{actionable:true}});
function commit(p,value,candidates=[]){const prepared=p.prepare(value,candidates);prepared.ack();return prepared.value;}
test('subscriptions reject arbitrary destinations, non-TLS, credentials and malformed keys',()=>{
 for(const endpoint of ['https://127.0.0.1/a','https://fcm.googleapis.com.evil.test/a','http://fcm.googleapis.com/a','https://x@fcm.googleapis.com/a','https://fcm.googleapis.com:444/a'])assert.throws(()=>validateSubscription({...sub(),endpoint}));
 assert.throws(()=>validateSubscription({...sub(),keys:{auth:'a',p256dh:'b'}}));
 assert.deepEqual(validateSubscription(sub()),sub());
});
test('registration is pending until checkpoint acknowledgment; secrets stay off public status',()=>{
 let now=100000;const p=createPushAlerts({keys,clock:()=>now});let v=commit(p,base());const r=p.register(v,sub());
 assert.equal(p.deviceStatus(v,r.token).active,false);assert.equal(p.deviceStatus(v,r.token).pending,true);
 const proposed=p.prepare(v);assert.equal(p.deviceStatus(v,r.token).active,false); // failed/throttled save never acknowledges
 v=proposed.value;proposed.ack();assert.equal(p.deviceStatus(v,r.token).active,true);assert.equal(p.needsSave(v),false);
 assert.doesNotMatch(JSON.stringify(p.deviceStatus(v,r.token)),/private|endpoint|capability|p256dh/);
 assert.throws(()=>p.register(v,sub(),'bad'));
 p.remove(v,'bad');v=commit(p,v);assert.equal(v.pushAlerts.devices.length,1);
 p.remove(v,r.token);v=commit(p,v);assert.equal(v.pushAlerts.devices.length,0);
});
test('alerts require acknowledged outbox, actionable entry and original recipient; no history replay',async()=>{
 let now=100000;const sent=[];const p=createPushAlerts({keys,clock:()=>now,send:async(...args)=>sent.push(args)});let v=commit(p,base());
 const s=signal(now);v.signals=[s];p.register(v,sub());v=commit(p,v);await p.deliver(v,[s]);assert.equal(sent.length,0);
 now+=1;const fresh=signal(now,'fresh');const proposed=p.prepare(v,[fresh]);await p.deliver(v,[fresh]);assert.equal(sent.length,0);
 v=proposed.value;proposed.ack();await p.deliver(v,[{...fresh,entryStatus:{actionable:false}}]);assert.equal(sent.length,0);
 await p.deliver(v,[fresh]);assert.equal(sent.length,1);assert.equal(JSON.parse(sent[0][1]).id,'fresh');assert.ok(sent[0][2].TTL<=180);
 await p.deliver(v,[fresh]);assert.equal(sent.length,1);
 v=commit(p,v);assert.equal(p.needsSave(v),false); // delivery ack cannot starve future signal saves
 const restarted=createPushAlerts({keys,clock:()=>now,send:async(...args)=>sent.push(args)});await restarted.deliver(v,[fresh]);assert.equal(sent.length,1);
});
test('restart retries only fresh undelivered events; expired or invalidated events cannot notify',async()=>{
 let now=100000,count=0;const p=createPushAlerts({keys,clock:()=>now,send:async()=>count++});let v=commit(p,base());p.register(v,sub());v=commit(p,v);const s=signal(now);v=commit(p,v,[s]);
 await p.deliver(v,[{...s,status:'INVALIDATED'}]);assert.equal(count,0);
 now+=ALERT_TTL_MS+1;await p.deliver(v,[s]);assert.equal(count,0);v=commit(p,v);assert.equal(v.pushAlerts.outbox.length,0);
});
test('gone endpoints are removed only in next acknowledged checkpoint and device count is bounded',async()=>{
 let now=100000;const p=createPushAlerts({keys,clock:()=>now,send:async()=>{throw {statusCode:410};}});let v=commit(p,base());p.register(v,sub());v=commit(p,v);const s=signal(now);v=commit(p,v,[s]);await p.deliver(v,[s]);assert.equal(v.pushAlerts.devices.length,1);v=commit(p,v);assert.equal(v.pushAlerts.devices.length,0);assert.equal(p.needsSave(v),false);
 for(let i=0;i<MAX_DEVICES;i++)p.register(v,sub(String(i)));assert.throws(()=>p.register(v,sub('extra')));
});
test('transient delivery failures retry while fresh; payload carries entry/stop/targets and fixed safe URL',async()=>{
 let now=100000,n=0;const p=createPushAlerts({keys,clock:()=>now,send:async()=>{if(++n===1)throw {statusCode:503};}});let v=commit(p,base());p.register(v,sub());v=commit(p,v);const s=signal(now);v=commit(p,v,[s]);await p.deliver(v,[s]);await p.deliver(v,[s]);assert.equal(n,1);now+=30001;await p.deliver(v,[s]);assert.equal(n,2);
 const payload=signalPayload(s,now);assert.match(payload.body,/Entry 100 · SL 95 · TP 110 \/ 115 \/ 120/);assert.equal(payload.url,'/');
});
