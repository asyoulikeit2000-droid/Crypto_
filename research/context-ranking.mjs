import { evaluateContextEvidence } from "../strategy/context-evidence.mjs";
import { evaluateExecutionQuality } from "./execution-quality.mjs";

const STATUS_ORDER={HEALTHY:4,LEARNING:3,WATCH:2,DEGRADED:1};

function parseContextKey(key){
  const [family,symbol,regime]=String(key||"").split("|");
  return {family,symbol,regime};
}
function finite(v,fallback=0){
  const n=Number(v);
  return Number.isFinite(n)?n:fallback;
}

export function rankStrategyContexts(profile = {}, executionProfile = {}, policy = {}) {
  const rows=[];
  const keys=new Set([
    ...Object.keys(profile?.contexts || {}),
    ...Object.keys(executionProfile?.contexts || {})
  ]);

  for(const key of keys){
    const ctx=parseContextKey(key);
    if(!ctx.family || !ctx.symbol || !ctx.regime) continue;

    const evidence=evaluateContextEvidence(profile,ctx,policy.context || policy);
    const executionStats=executionProfile?.contexts?.[key] || {};
    const execution=evaluateExecutionQuality(executionStats,policy.execution || {});
    const stats=evidence.stats?.context || {};

    const economicEligible=evidence.executionEligible;
    const executionEligible=economicEligible && execution.status==="HEALTHY";
    const fillRate=executionStats.fillRate==null?null:finite(executionStats.fillRate);
    const executionScore=
      executionStats.completedCount >= 5
        ? (fillRate==null?0:(fillRate-0.25)*20)
          + Math.min(8,Math.log1p(Math.max(0,finite(executionStats.filledPerDay)))*2)
          - Math.min(6,finite(executionStats.p90FillLatencyMs)/10_000)
        : 0;

    let status=evidence.status;
    if(execution.status==="DEGRADED") status="DEGRADED";
    else if(status==="HEALTHY" && execution.status==="WATCH") status="WATCH";

    rows.push({
      ...ctx,
      status,
      economicStatus:evidence.status,
      executionStatus:execution.status,
      researchBlocked:evidence.researchBlocked,
      executionBlocked:execution.executionBlocked,
      executionEligible,
      sampleCount:finite(stats.sampleCount),
      recentSampleCount:finite(stats.recentSampleCount),
      avgNetBps:finite(stats.avgNetBps),
      recentAvgNetBps:finite(stats.recentAvgNetBps),
      profitFactor:finite(stats.profitFactor),
      winRate:finite(stats.winRate),
      maxDrawdownPct:finite(stats.maxDrawdownPct),
      shrunkNetBps:finite(evidence.shrunkNetBps),
      conservativeNetBps:evidence.conservativeNetBps,
      attemptCount:finite(executionStats.attemptCount),
      completedAttemptCount:finite(executionStats.completedCount),
      fillRate,
      expiryRate:executionStats.expiryRate==null?null:finite(executionStats.expiryRate),
      avgFillLatencyMs:finite(executionStats.avgFillLatencyMs),
      p90FillLatencyMs:finite(executionStats.p90FillLatencyMs),
      attemptsPerDay:finite(executionStats.attemptsPerDay),
      filledPerDay:finite(executionStats.filledPerDay),
      score:finite(evidence.contextScore)+executionScore
    });
  }

  return rows.sort((a,b)=>{
    if(Number(b.executionEligible)!==Number(a.executionEligible)) return Number(b.executionEligible)-Number(a.executionEligible);
    if((STATUS_ORDER[b.status]||0)!==(STATUS_ORDER[a.status]||0)) return (STATUS_ORDER[b.status]||0)-(STATUS_ORDER[a.status]||0);
    if(b.score!==a.score) return b.score-a.score;
    if(b.sampleCount!==a.sampleCount) return b.sampleCount-a.sampleCount;
    if(b.completedAttemptCount!==a.completedAttemptCount) return b.completedAttemptCount-a.completedAttemptCount;
    return a.family.localeCompare(b.family)||a.symbol.localeCompare(b.symbol)||a.regime.localeCompare(b.regime);
  });
}
