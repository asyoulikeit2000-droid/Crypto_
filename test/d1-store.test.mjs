import test from "node:test";
import assert from "node:assert/strict";

test("D1 adapter sends authenticated health and kv requests", async()=>{
  process.env.CLOUDFLARE_D1_RELAY_URL="https://example.invalid";
  process.env.CLOUDFLARE_D1_RELAY_TOKEN="secret-token";

  const calls=[];
  const priorFetch=globalThis.fetch;
  globalThis.fetch=async(url,opts={})=>{
    calls.push({url:String(url),opts});
    if(String(url).endsWith("/health")){
      return new Response(JSON.stringify({ok:true,backend:"cloudflare-d1"}),{status:200,headers:{"content-type":"application/json"}});
    }
    return new Response(JSON.stringify({ok:true,rows:[{id:"x",value:1}]}),{status:200,headers:{"content-type":"application/json"}});
  };
  try{
    const mod=await import("../storage/d1-store.mjs?test="+Date.now());
    assert.equal(mod.d1Configured(),true);
    const store=mod.createD1Compat();
    await store.initialize();
    assert.equal(await store.healthcheck(),true);
    const rows=await store.db("probe","GET",{id:"eq.x",select:"id,value"});
    assert.deepEqual(rows,[{id:"x",value:1}]);
    assert.equal(store.backend,"cloudflare_d1");
    assert.equal(calls[0].opts.headers.authorization,"Bearer secret-token");
    const kv=JSON.parse(calls.at(-1).opts.body);
    assert.equal(kv.table,"probe");
    assert.equal(kv.method,"GET");
    assert.equal(kv.params.id,"eq.x");
  }finally{
    globalThis.fetch=priorFetch;
  }
});
