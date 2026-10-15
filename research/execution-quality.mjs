function finite(v,fallback=0){
  const n=Number(v);
  return Number.isFinite(n)?n:fallback;
}
function upper(v,fallback="UNKNOWN"){ return String(v||fallback).toUpperCase(); }
function mean(xs){ return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0; }
function percentile(xs,p){
  if(!xs.length) return 0;
  const a=[...xs].sort((x,y)=>x-y);
  const i=Math.max(0,Math.min(a.length-1,Math.ceil(p*a.length)-1));
  return a[i];
}
function groupPush(map,key,row){
  const a=map.get(key)||[];
  a.push(row);
  map.set(key,a);
}

export function summarizeExecutionAttempts(attempts=[],{
  now=Date.now(),
  minThroughputWindowHours=6
}={}){
  const rows=(attempts||[])
    .filter(x=>x?.metadata?.attempt_only===true || String(x?.trial_id||"").startsWith("ATTEMPT:"))
    .map(x=>({
      ...x,
      status:upper(x.status),
      family:String(x.family||"UNKNOWN"),
      symbol:upper(x.symbol),
      regime:upper(x.regime),
      submittedAt:Date.parse(x.opened_at||"") || finite(x?.metadata?.maker_order?.submittedAt),
      completedAt:Date.parse(x.closed_at||"") || null,
      fillLatencyMs:finite(x?.metadata?.fill_latency_ms,null)
    }))
    .sort((a,b)=>finite(a.submittedAt)-finite(b.submittedAt));

  const filled=rows.filter(x=>x.status==="FILLED");
  const expired=rows.filter(x=>x.status==="EXPIRED");
  const pending=rows.filter(x=>x.status==="PENDING");
  const completed=filled.length+expired.length;
  const latencies=filled.map(x=>finite(x.fillLatencyMs,null)).filter(Number.isFinite);

  const first=rows.length?finite(rows[0].submittedAt,now):now;
  const windowMs=Math.max(
    Math.max(1,finite(minThroughputWindowHours,6))*3600_000,
    Math.max(1,now-first)
  );
  const days=windowMs/86_400_000;

  return {
    attemptCount:rows.length,
    completedCount:completed,
    filledCount:filled.length,
    expiredCount:expired.length,
    pendingCount:pending.length,
    fillRate:completed?filled.length/completed:null,
    expiryRate:completed?expired.length/completed:null,
    avgFillLatencyMs:mean(latencies),
    p90FillLatencyMs:percentile(latencies,0.90),
    attemptsPerDay:rows.length/days,
    filledPerDay:filled.length/days,
    firstAttemptAt:rows.length?new Date(first).toISOString():null,
    lastAttemptAt:rows.length?new Date(finite(rows.at(-1).submittedAt,now)).toISOString():null
  };
}

function summarizeMap(map,options){
  return Object.fromEntries([...map.entries()].map(([k,rows])=>[
    k,summarizeExecutionAttempts(rows,options)
  ]));
}

export function buildExecutionQualityProfile(attempts=[],options={}){
  const family=new Map(),symbol=new Map(),regime=new Map(),context=new Map();
  for(const row of attempts||[]){
    if(!(row?.metadata?.attempt_only===true || String(row?.trial_id||"").startsWith("ATTEMPT:"))) continue;
    const f=String(row.family||"UNKNOWN");
    const s=upper(row.symbol);
    const r=upper(row.regime);
    groupPush(family,f,row);
    groupPush(symbol,`${f}|${s}`,row);
    groupPush(regime,`${f}|${r}`,row);
    groupPush(context,`${f}|${s}|${r}`,row);
  }
  return {
    attempts:summarizeExecutionAttempts(attempts,options),
    families:summarizeMap(family,options),
    symbols:summarizeMap(symbol,options),
    regimes:summarizeMap(regime,options),
    contexts:summarizeMap(context,options)
  };
}

export function evaluateExecutionQuality(stats={},policy={}){
  const completed=Math.max(0,finite(stats.completedCount));
  const fillRate=stats.fillRate==null?null:finite(stats.fillRate);
  const p90=finite(stats.p90FillLatencyMs);
  const learningSamples=Math.max(5,finite(policy.learningSamples,10));
  const decisionSamples=Math.max(20,finite(policy.decisionSamples,30));
  const minFillRate=finite(policy.minFillRate,0.20);
  const healthyFillRate=finite(policy.healthyFillRate,0.30);
  const maxP90LatencyMs=Math.max(1000,finite(policy.maxP90LatencyMs,25_000));

  if(completed<learningSamples){
    return {status:"LEARNING",executionBlocked:false,reasons:["insufficientCompletedAttempts"]};
  }

  if(completed>=decisionSamples && (
    fillRate<minFillRate ||
    (p90>maxP90LatencyMs && fillRate<healthyFillRate)
  )){
    return {
      status:"DEGRADED",
      executionBlocked:true,
      reasons:[
        ...(fillRate<minFillRate?["lowMakerFillRate"]:[]),
        ...(p90>maxP90LatencyMs?["slowMakerFills"]:[])
      ]
    };
  }

  if(completed>=decisionSamples && fillRate>=healthyFillRate && p90<=maxP90LatencyMs){
    return {status:"HEALTHY",executionBlocked:false,reasons:[]};
  }

  return {
    status:"WATCH",
    executionBlocked:false,
    reasons:[
      ...(fillRate<healthyFillRate?["makerFillRateBelowHealthy"]:[]),
      ...(p90>maxP90LatencyMs?["makerFillLatencyHigh"]:[])
    ]
  };
}
