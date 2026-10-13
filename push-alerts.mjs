import webpush from 'web-push';
import {createHash,randomBytes} from 'node:crypto';
export const ALERT_TTL_MS=180_000,MAX_DEVICES=20;
const hash=v=>createHash('sha256').update(v).digest('hex');
export function validateSubscription(s){
  if(!s||typeof s.endpoint!=='string'||s.endpoint.length>2048)throw new Error('Invalid subscription');
  const u=new URL(s.endpoint);
  const allowed=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(u.hostname);
  if(!allowed||u.protocol!=='https:'||u.port||u.username||u.password||u.hash)throw new Error('Unsupported push provider');
  const keys=s.keys;
  if(!keys||!['p256dh','auth'].every(k=>typeof keys[k]==='string'&&/^[A-Za-z0-9_-]+={0,2}$/.test(keys[k])))throw new Error('Invalid push keys');
  const pub=Buffer.from(keys.p256dh,'base64url'),auth=Buffer.from(keys.auth,'base64url');
  if(pub.length!==65||pub[0]!==4||auth.length!==16)throw new Error('Invalid push keys');
  return {endpoint:s.endpoint,keys:{p256dh:keys.p256dh,auth:keys.auth}};
}
export function signalPayload(s,now){
  return {title:`${s.symbol} · ${s.direction}`,body:`Entry ${s.entry} · SL ${s.stop} · TP ${s.targets.join(' / ')}. Recheck live entry eligibility.`,id:s.id,expiresAt:Math.min(s.entryValidUntil,s.createdAt+ALERT_TTL_MS),url:'/',sentAt:now};
}
// Private VAPID key and device capabilities stay inside the authenticated checkpoint.
// No independent database writes: registration and outbox share its CAS/throttle.
export function createPushAlerts({send=webpush.sendNotification,keys=webpush.generateVAPIDKeys,clock=Date.now}={}){
  const pending=new Map(),results=new Map(),attempts=new Map();let sending=false,lastDelivery=null,lastError=null;
  const state=value=>value?.pushAlerts;
  function initialize(value){value.pushAlerts||={...keys(),devices:[],outbox:[]};return value;}
  function register(value,subscription,token){
    const s=validateSubscription(subscription),id=hash(s.endpoint),p=state(value);
    const existing=p?.devices.find(d=>d.id===id)||pending.get(id)?.device;
    if(existing&&hash(token||'')!==existing.capability)throw new Error('This subscription needs its original device token; reset browser subscription first');
    if(!existing&&(p?.devices.length||0)+pending.size>=MAX_DEVICES)throw new Error('Notification device limit reached');
    const capabilityToken=existing?token:randomBytes(32).toString('base64url');
    pending.set(id,{kind:'add',device:{id,subscription:s,capability:hash(capabilityToken),subscribedAt:existing?.subscribedAt||clock()}});
    return {token:capabilityToken,active:!!existing&&!!p?.devices.find(d=>d.id===id)};
  }
  function deviceStatus(value,token){
    if(typeof token!=='string'||token.length!==43)return {active:false,pending:false};
    const capability=hash(token),active=!!state(value)?.devices.find(d=>d.capability===capability);
    return {active,pending:[...pending.values()].some(x=>x.device.capability===capability),lastDelivery,lastError};
  }
  function remove(value,token){
    const capability=hash(token||''),d=state(value)?.devices.find(d=>d.capability===capability)||[...pending.values()].find(x=>x.device.capability===capability)?.device;
    if(d)pending.set(d.id,{kind:'remove',device:d});
  }
  function needsSave(value){return pending.size>0||!state(value)||results.size>0;}
  function prepare(value,newSignals=[]){
    const next=initialize(structuredClone(value)),p=next.pushAlerts,batch=[...pending.entries()],resultBatch=[...results.entries()],now=clock();
    for(const [id,action]of batch){p.devices=p.devices.filter(d=>d.id!==id);if(action.kind==='add')p.devices.push(action.device);}
    p.devices=p.devices.filter(d=>!results.has('gone:'+d.id));
    p.outbox=p.outbox.filter(x=>x.expiresAt>now).map(x=>({...x,delivered:[...new Set([...x.delivered,...(results.get(x.id)||[])])]}));
    for(const s of newSignals){if(p.devices.length&&!p.outbox.some(x=>x.id===s.id))p.outbox.push({id:s.id,createdAt:s.createdAt,expiresAt:Math.min(s.entryValidUntil,s.createdAt+ALERT_TTL_MS),recipients:p.devices.filter(d=>d.subscribedAt<=s.createdAt).map(d=>d.id),delivered:[]});}
    return {value:next,ack(){for(const[id,action]of batch)if(pending.get(id)===action)pending.delete(id);for(const[k,v]of resultBatch)if(results.get(k)===v)results.delete(k);}};
  }
  async function deliver(value,signals){
    if(sending)return;sending=true;
    try{
      const p=state(value);if(!p)return;
      for(const event of p.outbox){
        const now=clock(),s=(typeof signals==='function'?signals():signals).find(s=>s.id===event.id);
        if(event.expiresAt<=now||s?.entryStatus?.actionable!==true||s.status!=='OPEN')continue;
        for(const d of p.devices){
          const currentNow=clock(),currentSignal=(typeof signals==='function'?signals():signals).find(s=>s.id===event.id);
          if(event.expiresAt<=currentNow||currentSignal?.entryStatus?.actionable!==true||currentSignal.status!=='OPEN')continue;
          const key=event.id+':'+d.id;
          if(!event.recipients.includes(d.id)||event.delivered.includes(d.id)||(results.get(event.id)||[]).includes(d.id)||results.has('gone:'+d.id)||currentNow-(attempts.get(key)||0)<30_000)continue;
          attempts.set(key,currentNow);
          try{await send(d.subscription,JSON.stringify(signalPayload(currentSignal,currentNow)),{vapidDetails:{subject:'https://crypto-engine-production-production.up.railway.app/',publicKey:p.publicKey,privateKey:p.privateKey},TTL:Math.max(0,Math.floor((event.expiresAt-clock())/1000)),urgency:'high',timeout:8000});results.set(event.id,[...(results.get(event.id)||[]),d.id]);lastDelivery=clock();lastError=null;}
          catch(e){if([404,410].includes(e.statusCode))results.set('gone:'+d.id,true);lastError='Push delivery unavailable; retrying while signal is fresh';}
        }
      }
      const live=new Set(p.outbox.filter(e=>e.expiresAt>clock()).map(e=>e.id));
      for(const k of results.keys())if(!k.startsWith('gone:')&&!live.has(k))results.delete(k);
      for(const k of attempts.keys())if(![...live].some(id=>k.startsWith(id+':')))attempts.delete(k);
    }finally{sending=false;}
  }
  return {initialize,register,remove,deviceStatus,needsSave,prepare,deliver};
}
export async function readPushBody(req){
  let size=0,body='';for await(const chunk of req){size+=chunk.length;if(size>4096)throw new Error('Request too large');body+=chunk;}
  return JSON.parse(body);
}
