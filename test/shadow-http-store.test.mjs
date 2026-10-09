import test from "node:test";
import assert from "node:assert/strict";
import { createShadowHttpStore } from "../storage/shadow-http-store.mjs";

test("shadow HTTP store translates research filters and never leaks token",async()=>{
  const calls=[];
  const fetchImpl=async(url,init={})=>{
    calls.push({url,init});
    return {
      ok:true,status:200,
      text:async()=>JSON.stringify({ok:true,rows:[{trial_id:"t1",status:"CLOSED"}]})
    };
  };
  const store=createShadowHttpStore({
    baseUrl:"https://example.workers.dev",
    token:"secret-value",
    fetchImpl
  });
  const rows=await store.db("strategy_trials","GET",{
    status:"eq.CLOSED",family:"eq.TREND_CONTINUATION_V1",order:"closed_at.asc",limit:"25"
  });
  assert.equal(rows.length,1);
  assert.match(calls[0].url,/status=CLOSED/);
  assert.match(calls[0].url,/family=TREND_CONTINUATION_V1/);
  assert.equal(calls[0].init.headers.authorization,"Bearer secret-value");
  assert.equal(JSON.stringify(rows).includes("secret-value"),false);
});

test("shadow HTTP store posts trial upserts",async()=>{
  let posted=null;
  const fetchImpl=async(url,init={})=>{
    posted={url,init};
    return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,count:1})};
  };
  const store=createShadowHttpStore({
    baseUrl:"https://example.workers.dev/",
    token:"x",
    fetchImpl
  });
  await store.db("strategy_trials","POST",{on_conflict:"trial_id"},{trial_id:"t1",status:"OPEN"});
  assert.equal(posted.url,"https://example.workers.dev/trials");
  assert.equal(posted.init.method,"POST");
  assert.equal(JSON.parse(posted.init.body).trial_id,"t1");
});
