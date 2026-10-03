const relayUrl=(process.env.CLOUDFLARE_D1_RELAY_URL||"").replace(/\/$/,"");
const relayToken=process.env.CLOUDFLARE_D1_RELAY_TOKEN||"";

export function d1Configured(){
  return Boolean(relayUrl&&relayToken);
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function request(path,{method="GET",body}={},attempts=4){
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),Number(process.env.D1_RELAY_TIMEOUT_MS||12000));
    try{
      const response=await fetch(relayUrl+path,{
        method,
        headers:{
          authorization:"Bearer "+relayToken,
          accept:"application/json",
          ...(body?{"content-type":"application/json"}:{})
        },
        body:body?JSON.stringify(body):undefined,
        signal:controller.signal
      });
      const text=await response.text();
      let parsed=null;
      try{parsed=text?JSON.parse(text):null}catch{}
      if(response.ok)return parsed;
      const message="D1 relay HTTP "+response.status+" "+(parsed?.error||text||"");
      if(response.status===429||response.status>=500){
        lastError=new Error(message);
        if(attempt<attempts){await sleep(250*attempt);continue;}
      }
      throw new Error(message);
    }catch(error){
      lastError=error;
      const transient=/fetch failed|aborted|timeout|ECONNRESET|EAI_AGAIN|ENOTFOUND|HTTP 429|HTTP 5\d\d/i.test(String(error?.message||error));
      if(!transient||attempt===attempts)throw error;
      await sleep(250*attempt);
    }finally{clearTimeout(timer);}
  }
  throw lastError;
}

export function createD1Compat(){
  if(!d1Configured())throw new Error("Cloudflare D1 relay not configured");

  async function initialize(){
    const h=await request("/health");
    if(!h?.ok)throw new Error("Cloudflare D1 relay initialization failed");
  }

  async function healthcheck(){
    try{
      const h=await request("/health");
      return Boolean(h?.ok);
    }catch{return false;}
  }

  async function db(table,method="GET",params={},body,extraHeaders={}){
    const payload={
      table,
      method:String(method||"GET").toUpperCase(),
      params:params||{},
      body,
      prefer:String(extraHeaders?.Prefer||"")
    };
    const r=await request("/kv",{method:"POST",body:payload});
    if(!r?.ok)throw new Error("Cloudflare D1 relay operation failed");
    return Array.isArray(r.rows)?r.rows:[];
  }

  async function markHealth(component,status,metadata={}){
    await db("runtime_health","POST",{on_conflict:"component"},{
      component,status,checked_at:new Date().toISOString(),metadata
    },{Prefer:"resolution=merge-duplicates,return=minimal"});
  }

  return {initialize,healthcheck,db,markHealth,backend:"cloudflare_d1"};
}
