// Engine-only namespace in the existing database. No generic SQL/table access.
const TABLE='engine_free_checkpoints',KEY='mtf_v1',MAX_BYTES=1_400_000;
export const SAVE_SQL="INSERT INTO kv_rows(table_name,row_key,created_at,updated_at,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(table_name,row_key) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json WHERE json_extract(kv_rows.payload_json,'$.data.savedAt')=? AND json_extract(kv_rows.payload_json,'$.data.savedAt')<=?";
async function digest(s){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export default {async fetch(request,env) {
  try {
    const token=request.headers.get('authorization')||'';
    if(!token.startsWith('Bearer ')||!env.ENGINE_TOKEN_HASH||await digest(token.slice(7))!==env.ENGINE_TOKEN_HASH)return Response.json({ok:false,error:'unauthorized'},{status:401});
    if(new URL(request.url).pathname!=='/checkpoint')return Response.json({ok:false,error:'not_found'},{status:404});
    if(request.method==='GET') {
      const r=await env.DB.prepare('SELECT payload_json FROM kv_rows WHERE table_name=? AND row_key=?').bind(TABLE,KEY).all();
      return Response.json({ok:true,data:r.results?.[0]?JSON.parse(r.results[0].payload_json).data:null,meta:r.meta});
    }
    if(request.method!=='POST')return Response.json({ok:false,error:'method_not_allowed'},{status:405});
    const raw=await request.text();if(new TextEncoder().encode(raw).length>MAX_BYTES+1000)return Response.json({ok:false,error:'document_too_large'},{status:413});
    const body=JSON.parse(raw),data=body.data,expected=body.expectedSavedAt,now=Date.now();
    if(!data||data.version!==1||!Array.isArray(data.signals)||data.signals.length>170||!Array.isArray(data.symbols)||data.symbols.length>30||!data.histories||!Number.isSafeInteger(expected)||expected<0)return Response.json({ok:false,error:'invalid_checkpoint'},{status:400});
    data.savedAt=now;
    const payload=JSON.stringify({id:KEY,data});
    if(new TextEncoder().encode(payload).length>MAX_BYTES)return Response.json({ok:false,error:'document_too_large'},{status:413});
    // For a missing row only expected=0 may create it. Normal CAS updates use
    // INSERT ... SELECT, avoiding accidental recreation of a lost checkpoint.
    const sql=expected===0?SAVE_SQL:SAVE_SQL.replace('VALUES(?,?,?,?,?)','SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM kv_rows WHERE table_name=\'engine_free_checkpoints\' AND row_key=\'mtf_v1\')');
    const result=await env.DB.prepare(sql).bind(TABLE,KEY,new Date(now).toISOString(),new Date(now).toISOString(),payload,expected,now-120000).run();
    if(!result.meta?.changes)return Response.json({ok:false,error:'checkpoint_conflict_or_throttled'},{status:409});
    return Response.json({ok:true,data,meta:result.meta});
  }catch(e){return Response.json({ok:false,error:String(e.message||e)},{status:500});}
}};
