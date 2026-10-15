import { lowerConfidenceMeanBps } from "./performance-gate.mjs";
import { getContextStats } from "../research/performance-profile.mjs";

function finite(v,fallback=0){
  const n=Number(v);
  return Number.isFinite(n)?n:fallback;
}
function clamp(x,a,b){ return Math.max(a,Math.min(b,x)); }

function shrink(prior, stats, strength){
  if(!stats) return prior;
  const n=Math.max(0,finite(stats.sampleCount));
  const w=n/(n+Math.max(1,strength));
  return prior*(1-w)+finite(stats.avgNetBps)*w;
}

function segmentState(stats, policy = {}) {
  if(!stats) return {status:"LEARNING",strong:false,reasons:["noData"]};
  const n=Math.max(0,finite(stats.sampleCount));
  const recentN=Math.max(0,finite(stats.recentSampleCount));
  const avg=finite(stats.avgNetBps);
  const recent=finite(stats.recentAvgNetBps);
  const pf=finite(stats.profitFactor,1);
  const lcb=lowerConfidenceMeanBps(stats);
  const blockSamples=Math.max(30,finite(policy.blockSamples,50));
  const blockRecent=Math.max(15,finite(policy.blockRecentSamples,20));

  const strongNegative=n>=blockSamples && recentN>=blockRecent &&
    ((recent<=finite(policy.degradeRecentBps,-1) && pf<finite(policy.degradeProfitFactor,0.9)) ||
     (avg<=finite(policy.degradeAverageBps,-1) && lcb<0));

  if(strongNegative){
    return {
      status:"DEGRADED",
      strong:true,
      reasons:["negativeAfterCostEdge"],
      diagnostics:{sampleCount:n,recentSampleCount:recentN,avgNetBps:avg,recentAvgNetBps:recent,profitFactor:pf,lowerConfidenceMeanBps:lcb}
    };
  }

  const watchSamples=Math.max(15,finite(policy.watchSamples,20));
  if(n>=watchSamples && (recent<0 || avg<0)){
    return {
      status:"WATCH",
      strong:false,
      reasons:["weakRecentEdge"],
      diagnostics:{sampleCount:n,recentSampleCount:recentN,avgNetBps:avg,recentAvgNetBps:recent,profitFactor:pf,lowerConfidenceMeanBps:lcb}
    };
  }

  return {
    status:n>=watchSamples?"STABLE":"LEARNING",
    strong:false,
    reasons:n>=watchSamples?[]:["insufficientData"],
    diagnostics:{sampleCount:n,recentSampleCount:recentN,avgNetBps:avg,recentAvgNetBps:recent,profitFactor:pf,lowerConfidenceMeanBps:lcb}
  };
}

export function evaluateContextEvidence(profile = {}, {
  family,
  symbol,
  regime
} = {}, policy = {}) {
  const stats=getContextStats(profile,{family,symbol,regime});
  if(!stats.global){
    return {
      status:"LEARNING",
      researchBlocked:false,
      executionEligible:false,
      shrunkNetBps:0,
      conservativeNetBps:-Infinity,
      reasons:["noFamilyEvidence"],
      segments:{global:{status:"LEARNING"},symbol:{status:"LEARNING"},regime:{status:"LEARNING"},context:{status:"LEARNING"}},
      stats
    };
  }

  const states={
    global:segmentState(stats.global,policy),
    symbol:segmentState(stats.symbol,policy),
    regime:segmentState(stats.regime,policy),
    context:segmentState(stats.context,policy)
  };

  let shrunk=finite(stats.global.avgNetBps);
  shrunk=shrink(shrunk,stats.symbol,finite(policy.symbolPriorStrength,80));
  shrunk=shrink(shrunk,stats.regime,finite(policy.regimePriorStrength,80));
  shrunk=shrink(shrunk,stats.context,finite(policy.contextPriorStrength,40));

  const contextN=Math.max(0,finite(stats.context?.sampleCount));
  const contextRecentN=Math.max(0,finite(stats.context?.recentSampleCount));
  const contextLcb=stats.context ? lowerConfidenceMeanBps(stats.context) : -Infinity;
  const symbolLcb=stats.symbol ? lowerConfidenceMeanBps(stats.symbol) : -Infinity;
  const regimeLcb=stats.regime ? lowerConfidenceMeanBps(stats.regime) : -Infinity;
  const globalLcb=lowerConfidenceMeanBps(stats.global);

  const researchBlocked=
    states.context.status==="DEGRADED" ||
    (states.symbol.status==="DEGRADED" && states.regime.status==="DEGRADED");

  const minExecutionSamples=Math.max(30,finite(policy.minExecutionContextSamples,50));
  const minExecutionRecent=Math.max(15,finite(policy.minExecutionRecentSamples,20));
  const minNetBps=finite(policy.minExecutionAvgNetBps,1);
  const minPf=finite(policy.minExecutionProfitFactor,1.10);

  const executionEligible=
    !researchBlocked &&
    contextN>=minExecutionSamples &&
    contextRecentN>=minExecutionRecent &&
    finite(stats.context?.avgNetBps)>=minNetBps &&
    finite(stats.context?.recentAvgNetBps)>0 &&
    finite(stats.context?.profitFactor,0)>=minPf &&
    contextLcb>0 &&
    symbolLcb>0 &&
    regimeLcb>0 &&
    globalLcb>0;

  const conservativeNetBps=executionEligible
    ? Math.min(globalLcb,symbolLcb,regimeLcb,contextLcb,shrunk)
    : -Infinity;

  let status="LEARNING";
  if(researchBlocked) status="DEGRADED";
  else if(executionEligible) status="HEALTHY";
  else if(states.context.status==="WATCH" || states.symbol.status==="WATCH" || states.regime.status==="WATCH") status="WATCH";

  const reasons=[];
  if(researchBlocked) reasons.push("contextDegraded");
  if(!researchBlocked && !executionEligible){
    if(contextN<minExecutionSamples) reasons.push("contextSamples");
    if(contextRecentN<minExecutionRecent) reasons.push("recentContextSamples");
    if(!(contextLcb>0)) reasons.push("contextConfidenceBound");
    if(!(symbolLcb>0)) reasons.push("symbolConfidenceBound");
    if(!(regimeLcb>0)) reasons.push("regimeConfidenceBound");
  }

  const contextScore=
    clamp(shrunk,-25,25) +
    clamp((finite(stats.context?.profitFactor,1)-1)*8,-8,8) -
    clamp(finite(stats.context?.maxDrawdownPct)*100,0,10);

  return {
    status,
    researchBlocked,
    executionEligible,
    shrunkNetBps:shrunk,
    conservativeNetBps,
    contextScore,
    reasons,
    segments:states,
    stats
  };
}
