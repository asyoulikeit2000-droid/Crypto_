import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';
import worker from '../cloudflare/free-checkpoint-relay.mjs';
import {createFreeTransport} from '../storage/free-transport.mjs';
const digest=async s=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');
test('checkpoint relay enforces auth, atomic CAS, server throttle and lost-row protection',async()=>{
  const client=createClient({url:'file::memory:'});
  await client.execute('CREATE TABLE kv_rows(table_name TEXT,row_key TEXT,created_at TEXT,updated_at TEXT,payload_json TEXT,PRIMARY KEY(table_name,row_key))');
  const env={ENGINE_TOKEN_HASH:await digest('test-only'),DB:{prepare(sql){return {bind(...args){return {async run(){const r=await client.execute({sql,args});return {meta:{changes:r.rowsAffected}};},async all(){const r=await client.execute({sql,args});return {results:r.rows};}};}};}}};
  const post=async(expectedSavedAt,auth='Bearer test-only')=>worker.fetch(new Request('https://example.test/checkpoint',{method:'POST',headers:{authorization:auth},body:JSON.stringify({expectedSavedAt,data:{version:1,signals:[],symbols:[],histories:{}}})}),env);
  try {
    assert.equal((await post(0,'')).status,401);
    let r=await post(0);assert.equal(r.status,200);const first=(await r.json()).data;
    assert.equal((await post(first.savedAt)).status,409);
    assert.equal((await post(0)).status,409);
    const old=Date.now()-121000;
    await client.execute({sql:"UPDATE kv_rows SET payload_json=json_set(payload_json,'$.data.savedAt',?)",args:[old]});
    const outcomes=await Promise.all([post(old),post(old)]);assert.deepEqual(outcomes.map(x=>x.status).sort(),[200,409]);
    await client.execute('DELETE FROM kv_rows');
    assert.equal((await post(old)).status,409);
    assert.equal((await post(0)).status,200);
  }finally{client.close();}
});
test('transport treats missing acknowledgement and conflict as failures',async()=>{
  const missing=createFreeTransport({url:'https://x.test',token:'test',fetcher:async()=>Response.json({ok:true})});
  await assert.rejects(missing.db('x','POST',{},{}),/acknowledgement/);
  const conflict=createFreeTransport({url:'https://x.test',token:'test',fetcher:async()=>Response.json({ok:false},{status:409})});
  await assert.rejects(conflict.db('x','POST',{},{}),e=>e.conflict===true);
});
