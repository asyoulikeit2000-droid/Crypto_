import test from "node:test";
import assert from "node:assert/strict";
import { grtFramework, decideAction } from "../rescue-strategy.mjs";

test("GRT rescue framework preserves agreed fixed levels",()=>{
  const f=grtFramework("GRTUSDT",0.03,null,null,null);
  assert.equal(f.hedgeTrigger,0.02790);
  assert.equal(f.hard4h,0.02720);
  assert.equal(f.reduceTrigger,0.02650);
  assert.equal(f.resistance1,0.02940);
  assert.equal(f.resistance2,0.03050);
  assert.equal(f.resistance3,0.03110);
  assert.equal(f.entryZone,0.03500);
  assert.equal(f.profitExtension,0.03670);
  assert.equal(f.source,"agreed_grt_rescue_framework");
});

test("GRT downside actions require completed-close inputs",()=>{
  const framework=grtFramework("GRTUSDT",0.0275,null,null,null);
  assert.equal(decideAction({direction:"long",price:0.0275,entry:0.035,hedgeNotional:0,h1Close:0.0280,h4Close:0.0281,score:-2,framework}).action,"HOLD");
  assert.equal(decideAction({direction:"long",price:0.0275,entry:0.035,hedgeNotional:0,h1Close:0.02789,h4Close:0.0281,score:-2,framework}).action,"HEDGE");
  assert.equal(decideAction({direction:"long",price:0.0270,entry:0.035,hedgeNotional:0,h1Close:0.0275,h4Close:0.02719,score:-2,framework}).secondaryAction,"TARGET ~50% HEDGE");
  assert.equal(decideAction({direction:"long",price:0.0264,entry:0.035,hedgeNotional:0,h1Close:0.0270,h4Close:0.02649,score:-3,framework}).action,"REDUCE");
});

test("recovery can exit a hedge and entry recovery de-risks",()=>{
  const framework=grtFramework("GRTUSDT",0.031,null,null,null);
  assert.equal(decideAction({direction:"long",price:0.031,entry:0.035,hedgeNotional:10000,h1Close:0.0308,h4Close:0.0306,score:1.2,framework}).action,"EXIT-HEDGE");
  const atEntry=decideAction({direction:"long",price:0.0352,entry:0.035,hedgeNotional:0,h1Close:0.034,h4Close:0.034,score:3,framework});
  assert.equal(atEntry.action,"REDUCE");
  assert.match(atEntry.secondaryAction,/PARTIAL PROFIT/);
});
