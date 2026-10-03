import { evaluateContextEvidence } from "../strategy/context-evidence.mjs";

const STATUS_ORDER={HEALTHY:4,LEARNING:3,WATCH:2,DEGRADED:1};

function parseContextKey(key){
  const [family,symbol,regime]=String(key||"").split("|");
  return {family,symbol,regime};
}
function finite(v,fallback=0){
  const n=Number(v);
  return Number.isFinite(n)?n:fallback;
}

export function rankStrategyContexts(profile = {}, policy = {}) {
  const rows=[];
  for(const key of Object.keys(profile?.contexts || {})){
    const ctx=parseContextKey(key);
    if(!ctx.family || !ctx.symbol || !ctx.regime) continue;
    const evidence=evaluateContextEvidence(profile,ctx,policy);
    const stats=evidence.stats?.context || {};
    rows.push({
      ...ctx,
      status:evidence.status,
      researchBlocked:evidence.researchBlocked,
      executionEligible:evidence.executionEligible,
      sampleCount:finite(stats.sampleCount),
      recentSampleCount:finite(stats.recentSampleCount),
      avgNetBps:finite(stats.avgNetBps),
      recentAvgNetBps:finite(stats.recentAvgNetBps),
      profitFactor:finite(stats.profitFactor),
      winRate:finite(stats.winRate),
      maxDrawdownPct:finite(stats.maxDrawdownPct),
      shrunkNetBps:finite(evidence.shrunkNetBps),
      conservativeNetBps:evidence.conservativeNetBps,
      score:finite(evidence.contextScore)
    });
  }

  return rows.sort((a,b)=>{
    if(Number(b.executionEligible)!==Number(a.executionEligible)) return Number(b.executionEligible)-Number(a.executionEligible);
    if((STATUS_ORDER[b.status]||0)!==(STATUS_ORDER[a.status]||0)) return (STATUS_ORDER[b.status]||0)-(STATUS_ORDER[a.status]||0);
    if(b.score!==a.score) return b.score-a.score;
    if(b.sampleCount!==a.sampleCount) return b.sampleCount-a.sampleCount;
    return a.family.localeCompare(b.family)||a.symbol.localeCompare(b.symbol)||a.regime.localeCompare(b.regime);
  });
}
