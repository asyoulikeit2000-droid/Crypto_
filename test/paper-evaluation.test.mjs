import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {evaluatePaperPath,readPaperPath,verifiedPaperOutcome} from '../paper-evaluation.mjs';
import {validateRecordedEvidence} from '../evidence-validation.mjs';
import {evaluateSignalReadiness} from '../signal-gates.mjs';

const start=Date.parse('2026-10-03T00:00:00Z');
const iso=s=>new Date(start+s*1000).toISOString();
const trade=(side='LONG')=>({paper_trade_id:'p',signal_id:'s',side,entry_price:100,quantity:1,
  opened_at:iso(0),fees:.055,slippage:.015,funding_cost:0,
  metadata:{asset_id:'a',max_horizon_seconds:300,stop_loss:side==='LONG'?95:105,
    target_1:side==='LONG'?105:95,target_2:side==='LONG'?110:90,target_3:side==='LONG'?115:85}});
const ticks=xs=>xs.map(([s,price])=>({observed_at:iso(s),price}));

test('terminal exit bounds target hits, excursions and duration for both directions',()=>{
  for(const side of ['LONG','SHORT']){
    const t=trade(side),stop=side==='LONG'?94:106,target=side==='LONG'?116:84;
    const r=evaluatePaperPath(t,ticks([[10,stop],[20,target]]),start+30000);
    assert.equal(r.outcome,'STOP_LOSS');assert.equal(r.t1_hit,false);assert.equal(r.t3_hit,false);
    assert.equal(r.mfe,0);assert.equal(r.mae,.05);assert.equal(r.holding_seconds,10);
    const win=evaluatePaperPath(t,ticks([[10,target],[20,stop]]),start+30000);
    assert.equal(win.outcome,'TARGET_3');assert.equal(win.sl_hit,false);assert.equal(win.mae,0);
  }
});
test('intermediate targets before a stop retain their calibration evidence',()=>{
  const r=evaluatePaperPath(trade(),ticks([[10,106],[20,94],[30,116]]),start+40000);
  assert.equal(r.t1_hit,true);assert.equal(r.t2_hit,false);assert.equal(r.t3_hit,false);
});
test('equal-time conflicting observations use the conservative stop-first result',()=>{
  for(const side of ['LONG','SHORT']){
    const path=side==='LONG'?[[10,116],[10,94]]:[[10,84],[10,106]];
    assert.equal(evaluatePaperPath(trade(side),ticks(path),start+20000).outcome,'STOP_LOSS');
  }
});
test('deadline excludes late targets and records deadline-price policy',()=>{
  const r=evaluatePaperPath(trade(),ticks([[10,100],[100,101],[200,102],[290,103],[310,116]]),start+400000);
  assert.equal(r.outcome,'TIMEOUT');assert.equal(r.exit_price,103);assert.equal(r.holding_seconds,300);
  assert.equal(r.t1_hit,false);
});
test('missing entry coverage, internal gaps and absent deadline prices do not create outcomes',()=>{
  for(const path of [[],[[121,116]],[[10,100],[200,116]],[[10,100],[100,101]]]){
    assert.equal(evaluatePaperPath(trade(),ticks(path),start+400000),null);
  }
});
test('future, malformed and pre-entry observations cannot supply a fill',()=>{
  const path=[{observed_at:'bad',price:116},...ticks([[-1,116],[500,116]])];
  assert.equal(evaluatePaperPath(trade(),path,start+100000),null);
  const t=trade();t.entry_price=NaN;assert.equal(evaluatePaperPath(t,ticks([[10,116]]),start+20000),null);
});
test('timestamp cursor paginates without losing the tail or using post-deadline rows',async()=>{
  const rows=ticks([[10,100],[100,101],[200,102],[290,103],[310,116]]),calls=[];
  const db=async(_t,_m,p)=>{calls.push(p);const ms=Date.parse(p.observed_at.slice(p.observed_at.indexOf('.')+1));return rows.filter(x=>p.observed_at.startsWith('gt.')?Date.parse(x.observed_at)>ms:Date.parse(x.observed_at)>=ms).slice(0,2);};
  const path=await readPaperPath(db,trade(),start+400000,2);
  assert.equal(path.length,4);assert.equal(calls.length,3);assert.equal(calls[1].observed_at,'gt.'+iso(100));
});
test('only complete versioned outcomes enter evidence',()=>{
  const good={...evaluatePaperPath(trade(),ticks([[10,116]]),start+20000),pnl_after_cost:14};
  assert.equal(verifiedPaperOutcome(good,300),true);
  for(const patch of [{evaluation_version:'paper_v2'},{path_valid:false},{holding_seconds:301},{exit_at:'bad'},{pnl_after_cost:null},{t1_hit:'true'}])
    assert.equal(verifiedPaperOutcome({...good,...patch},300),false);
});

function evidence(n=150){
  const signals=Array.from({length:n},(_,i)=>({signal_id:'s'+i,signal:'LONG',created_at:iso(i*300)}));
  const outcomes=signals.map((s,i)=>({signal_id:s.signal_id,exit_at:iso(i*300+60),t1_hit:false,pnl_after_cost:1,funding_model:'historical_settlements'}));
  return {signals,outcomes,now:start+(n*300+120)*1000};
}
test('five forward folds fit calibration only on earlier completed trades',()=>{
  const {signals,outcomes,now}=evidence();const a=validateRecordedEvidence(signals,outcomes,now);
  assert.equal(a.status,'COMPLETE');assert.equal(a.test.n,100);assert.equal(a.folds.length,5);
  for(const f of a.folds)assert.ok(Date.parse(f.trainLatestExit)<Date.parse(f.testStartsAt));
  for(let i=50;i<70;i++)outcomes[i].t1_hit=true;
  const b=validateRecordedEvidence(signals,outcomes,now);
  assert.deepEqual(a.folds[0].calibration,b.folds[0].calibration);
  assert.notEqual(a.folds[0].brierScore,b.folds[0].brierScore);
});
test('overlapping training outcomes and inadequate samples keep validation locked',()=>{
  let e=evidence(149);assert.equal(validateRecordedEvidence(e.signals,e.outcomes,e.now).status,'INSUFFICIENT_SAMPLE');
  e=evidence();e.outcomes[0].exit_at=e.signals[51].created_at;
  assert.equal(validateRecordedEvidence(e.signals,e.outcomes,e.now).status,'INSUFFICIENT_SAMPLE');
});
test('funding exclusions are visible and cannot pass readiness',()=>{
  const e=evidence();e.outcomes[100].funding_model='not_accrued';
  const v=validateRecordedEvidence(e.signals,e.outcomes,e.now);
  assert.equal(v.costCoverageComplete,false);
  assert.equal(evaluateSignalReadiness({status:'ACTIVE'},v).checks.costCoverageComplete,false);
  v.costCoverageComplete=true;assert.equal(evaluateSignalReadiness({status:'ACTIVE'},v).ready,true);
});

test('outcome-first closing recovers after failed close without changing the recorded result',async()=>{
  const source=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function managePaperTrades()'),source.indexOf('async function writeDataQuality()'));
  let saved=null,closed=null,fail=true,posts=0;
  class Clock extends Date{static now(){return start+20000;}}
  const context=vm.createContext({Date:Clock,iso:()=>iso(20),evaluatePaperPath,readPaperPath,
    finite:(x,d=0)=>Number.isFinite(Number(x))?Number(x):d,PAPER_FEE_RATE:.00055,PAPER_SLIPPAGE_RATE:.00015,
    recordError:()=>{},db:async(table,method,_params,body)=>{
      if(method==='GET')return table==='paper_trades'?(closed?[]:[trade()]):table==='signal_outcomes'?(saved?[saved]:[]):ticks([[10,116]]);
      if(table==='signal_outcomes'){posts++;saved=structuredClone(body);return [];}
      if(fail){fail=false;throw new Error('close interrupted');}closed=body;return [];
    }});
  vm.runInContext(fn,context);await vm.runInContext('managePaperTrades()',context);
  assert.ok(saved);assert.equal(closed,null);
  await vm.runInContext('managePaperTrades()',context);
  assert.equal(posts,1);assert.equal(closed.closed_at,iso(10));assert.equal(closed.realized_pnl,saved.pnl_after_cost);
  assert.ok(Math.abs(saved.pnl_after_cost-14.8495)<1e-9);
});
test('expired missing paths release the paper slot without creating validation evidence',async()=>{
  const source=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function managePaperTrades()'),source.indexOf('async function writeDataQuality()'));
  let patched=null,posts=0;
  class Clock extends Date{static now(){return start+400000;}}
  const context=vm.createContext({Date:Clock,iso:()=>iso(400),evaluatePaperPath,readPaperPath,PAPER_EVALUATION_VERSION:'paper_v3',recordError:e=>{throw e},
    db:async(table,method,_params,body)=>{
      if(method==='GET')return table==='paper_trades'?[trade()]:[];
      if(table==='signal_outcomes')posts++;
      patched=body;return [];
    }});
  vm.runInContext(fn,context);await vm.runInContext('managePaperTrades()',context);
  assert.equal(posts,0);assert.equal(patched.status,'INVALID_EVIDENCE');assert.equal(patched.realized_pnl,undefined);
});
