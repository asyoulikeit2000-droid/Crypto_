const IGNORED=new Set(["select","order","limit","offset","on_conflict","Prefer"]);
const GENERATED={
  universe_snapshots:"snapshot_id",universe_members:"member_id",signals:"signal_id",
  backtest_runs:"run_id",paper_trades:"paper_trade_id",model_calibrations:"calibration_id",
  system_events:"event_id",audit_logs:"audit_id",model_predictions:"prediction_id",
  setup_candidates:"setup_id",regime_states:"regime_state_id",feature_values:"feature_value_id",
  data_quality:"data_quality_id",orderbook_snapshots:"snapshot_id",scanner_tokens:"token_id",
  scanner_pairs:"pair_id",scanner_market_snapshots:"snapshot_id",scanner_evaluations:"evaluation_id"
};
const PREFERRED={
  signals:["signal_id"],signal_outcomes:["signal_id"],model_versions:["model_id"],
  model_calibrations:["calibration_id"],assets:["asset_id"],feature_registry:["feature_id"],
  provider_status:["provider","dataset"],kill_switch:["id"],paper_trades:["paper_trade_id"],
  scanner_tokens:["token_id"],scanner_pairs:["pair_id"],archive_manifest:["object_key"]
};

async function sha256Hex(value){
  const bytes=new TextEncoder().encode(value);
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
function parseScalar(v){
  if(v==="null")return null;if(v==="true")return true;if(v==="false")return false;
  if(/^-?\d+(?:\.\d+)?$/.test(v))return Number(v);
  return String(v).replace(/^"|"$/g,"");
}
function sqlValue(v){const x=parseScalar(v);if(x===true)return 1;if(x===false)return 0;return x}
function jsonExpr(field){
  if(!/^[A-Za-z0-9_]+$/.test(field))throw new Error("Unsupported storage field "+field);
  return "json_extract(payload_json,'$."+field+"')";
}
async function stableKey(table,row,conflict){
  const keys=conflict?String(conflict).split(",").map(x=>x.trim()).filter(Boolean):(PREFERRED[table]||[]);
  if(!keys.length||keys.some(k=>row?.[k]===undefined||row?.[k]===null))return crypto.randomUUID();
  const raw=table+"|"+keys.map(k=>k+"="+JSON.stringify(row[k])).join("|");
  return sha256Hex(raw);
}
function withGeneratedId(table,row){
  const field=GENERATED[table]; if(!field||row?.[field])return {...row};
  return {...row,[field]:crypto.randomUUID()};
}
function project(row,select){
  if(!select||select==="*")return row;
  const cols=String(select).split(",").map(x=>x.trim()).filter(x=>x&&!x.includes("("));
  if(!cols.length)return row;
  return Object.fromEntries(cols.map(k=>[k,row?.[k]]));
}
function buildQuery(table,params={}){
  const where=["table_name=?"];const args=[table];
  for(const [key,raw] of Object.entries(params||{})){
    if(IGNORED.has(key))continue;
    const expr=jsonExpr(key),s=String(raw??"");
    if(s.startsWith("eq.")){where.push(expr+" = ?");args.push(sqlValue(s.slice(3)));continue}
    if(s.startsWith("neq.")){where.push(expr+" != ?");args.push(sqlValue(s.slice(4)));continue}
    if(s.startsWith("gt.")){where.push(expr+" > ?");args.push(sqlValue(s.slice(3)));continue}
    if(s.startsWith("gte.")){where.push(expr+" >= ?");args.push(sqlValue(s.slice(4)));continue}
    if(s.startsWith("lt.")){where.push(expr+" < ?");args.push(sqlValue(s.slice(3)));continue}
    if(s.startsWith("lte.")){where.push(expr+" <= ?");args.push(sqlValue(s.slice(4)));continue}
    if(s==="is.null"){where.push(expr+" IS NULL");continue}
    if(s==="not.is.null"){where.push(expr+" IS NOT NULL");continue}
    if(s.startsWith("in.(")&&s.endsWith(")")){
      const vals=s.slice(4,-1).split(",").map(x=>sqlValue(x.trim()));
      if(!vals.length){where.push("1=0");continue}
      where.push(expr+" IN ("+vals.map(()=>"?").join(",")+")");args.push(...vals);continue
    }
    throw new Error("Unsupported storage filter "+key+"="+s);
  }
  let orderSql="updated_at DESC";
  if(params.order){
    const parts=String(params.order).split(".");
    const dir=String(parts[1]||"asc").toLowerCase()==="desc"?"DESC":"ASC";
    orderSql=jsonExpr(parts[0])+" "+dir;
  }
  const limit=Math.max(0,Math.min(50000,Number(params.limit??10000)));
  const offset=Math.max(0,Number(params.offset||0));
  return {sql:"SELECT row_key,payload_json FROM kv_rows WHERE "+where.join(" AND ")+" ORDER BY "+orderSql+" LIMIT ? OFFSET ?",args:[...args,limit,offset]};
}
async function queryEntries(env,table,params={}){
  const q=buildQuery(table,params);
  const r=await env.DB.prepare(q.sql).bind(...q.args).all();
  return (r.results||[]).map(x=>({rowKey:String(x.row_key),row:JSON.parse(String(x.payload_json))}));
}
async function kvDb(env,table,method="GET",params={},body,prefer=""){
  const now=new Date().toISOString();
  if(method==="GET"){
    const entries=await queryEntries(env,table,params);
    return entries.map(x=>project(x.row,params.select));
  }
  if(method==="POST"){
    const rows=(Array.isArray(body)?body:[body]).filter(Boolean);
    const conflict=params?.on_conflict||null;
    const returning=String(prefer).includes("return=representation");
    const merge=String(prefer).includes("merge-duplicates");
    const ignore=String(prefer).includes("ignore-duplicates");
    const out=[];
    for(const input of rows){
      let next=withGeneratedId(table,input);
      const key=await stableKey(table,next,conflict);
      if(merge){
        const ex=await env.DB.prepare("SELECT payload_json FROM kv_rows WHERE table_name=? AND row_key=? LIMIT 1").bind(table,key).first();
        if(ex?.payload_json)next={...JSON.parse(String(ex.payload_json)),...next};
      }
      const sql=ignore
        ?"INSERT OR IGNORE INTO kv_rows(table_name,row_key,created_at,updated_at,payload_json) VALUES(?,?,?,?,?)"
        :"INSERT INTO kv_rows(table_name,row_key,created_at,updated_at,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(table_name,row_key) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json";
      const result=await env.DB.prepare(sql).bind(table,key,now,now,JSON.stringify(next)).run();
      if(returning&&(!ignore||Number(result.meta?.changes||0)>0))out.push(next);
    }
    return returning?out:[];
  }
  if(method==="PATCH"){
    const entries=await queryEntries(env,table,{...params,limit:params.limit||10000});
    const stmts=[];const out=[];
    for(const item of entries){
      const next={...item.row,...(body||{})};
      stmts.push(env.DB.prepare("UPDATE kv_rows SET updated_at=?,payload_json=? WHERE table_name=? AND row_key=?").bind(now,JSON.stringify(next),table,item.rowKey));
      out.push(next);
    }
    if(stmts.length)await env.DB.batch(stmts);
    return String(prefer).includes("return=representation")?out:[];
  }
  if(method==="DELETE"){
    const entries=await queryEntries(env,table,{...params,limit:params.limit||10000});
    const stmts=entries.map(item=>env.DB.prepare("DELETE FROM kv_rows WHERE table_name=? AND row_key=?").bind(table,item.rowKey));
    if(stmts.length)await env.DB.batch(stmts);
    return [];
  }
  throw new Error("Unsupported storage method "+method);
}

export default {
  async fetch(request,env){
    try{
      const auth=request.headers.get("authorization")||"";
      if(!auth.startsWith("Bearer "))return Response.json({ok:false,error:"unauthorized"},{status:401});
      const expectedHash=String(env.ENGINE_TOKEN_HASH||"");
      const suppliedHash=await sha256Hex(auth.slice(7));
      if(!/^[a-f0-9]{64}$/.test(expectedHash)||suppliedHash!==expectedHash)return Response.json({ok:false,error:"unauthorized"},{status:401});
      const url=new URL(request.url);
      if(url.pathname==="/health"&&request.method==="GET"){
        const row=await env.DB.prepare("SELECT 1 AS ok").first();
        return Response.json({ok:Number(row?.ok||0)===1,service:"crypto-engine-storage-api",backend:"cloudflare-d1"});
      }
      if(url.pathname==="/kv"&&request.method==="POST"){
        const payload=await request.json();
        const rows=await kvDb(env,String(payload.table||""),String(payload.method||"GET").toUpperCase(),payload.params||{},payload.body,payload.prefer||"");
        return Response.json({ok:true,rows});
      }
      return Response.json({ok:false,error:"not_found"},{status:404});
    }catch(e){
      return Response.json({ok:false,error:String(e?.message||e)},{status:500});
    }
  }
};