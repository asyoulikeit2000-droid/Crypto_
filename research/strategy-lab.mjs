import { summarizeStrategyTrades } from "../strategy/performance-metrics.mjs";
import { buildPerformanceProfile } from "./performance-profile.mjs";
import { buildExecutionQualityProfile } from "./execution-quality.mjs";
import { evaluateTradeOutcome } from "./outcome-accounting.mjs";

function iso(ms=Date.now()){ return new Date(ms).toISOString(); }

function safeId(value) {
  return String(value || "").replace(/[^A-Za-z0-9:_-]/g,"").slice(0,120);
}

export function createStrategyLab({ db, costAssumptions = {} } = {}) {
  if (typeof db !== "function") throw new Error("strategy lab requires db");

  async function openTrial({
    trialId,
    family,
    symbol,
    side,
    regime,
    score,
    entryPrice,
    notionalUsd,
    stopPrice,
    targetPrice,
    metadata = {}
  } = {}) {
    const id=safeId(trialId || `${family}:${symbol}:${Date.now()}`);
    if (!id) throw new Error("trial id required");
    const row={
      trial_id:id,
      family:String(family||"UNKNOWN"),
      symbol:String(symbol||"").toUpperCase(),
      side:String(side||"").toUpperCase(),
      regime:String(regime||"UNKNOWN"),
      score:Number(score||0),
      opened_at:iso(),
      closed_at:null,
      entry_price:Number(entryPrice||0),
      exit_price:null,
      notional_usd:Number(notionalUsd||0),
      stop_price:Number(stopPrice||0),
      target_price:Number(targetPrice||0),
      status:"OPEN",
      outcome:null,
      metadata:{...metadata,research_only:true}
    };
    await db("strategy_trials","POST",{on_conflict:"trial_id"},row,{
      Prefer:"resolution=ignore-duplicates,return=minimal"
    });
    return row;
  }

  async function closeTrial(trial, {
    exitPrice,
    actualFeesUsd,
    actualSlippageUsd,
    actualFundingUsd,
    exitReason = "UNKNOWN",
    closedAt = iso(),
    metadataDetails = {}
  } = {}) {
    if (!trial?.trial_id) throw new Error("trial required");
    const outcome=evaluateTradeOutcome({
      side:trial.side,
      entryPrice:trial.entry_price,
      exitPrice,
      notionalUsd:trial.notional_usd,
      costAssumptions,
      actualFeesUsd,
      actualSlippageUsd,
      actualFundingUsd
    });
    if (!outcome.valid) throw new Error("invalid trial outcome");

    const merged={
      ...trial,
      exit_price:Number(exitPrice),
      closed_at:closedAt,
      status:"CLOSED",
      exit_reason:exitReason,
      outcome,
      metadata:{...(trial.metadata||{}),...(metadataDetails||{})}
    };
    await db("strategy_trials","POST",{on_conflict:"trial_id"},merged,{
      Prefer:"resolution=merge-duplicates,return=minimal"
    });
    return merged;
  }


  async function recordAttempt({
    attemptId,
    family,
    symbol,
    side,
    regime,
    score,
    signalPrice,
    limitPrice,
    notionalUsd,
    expiresAt,
    metadata={}
  } = {}) {
    const id=safeId(attemptId || `ATTEMPT:${family}:${symbol}:${Date.now()}`);
    if(!id) throw new Error("attempt id required");
    const row={
      trial_id:id,
      family:String(family||"UNKNOWN"),
      symbol:String(symbol||"").toUpperCase(),
      side:String(side||"").toUpperCase(),
      regime:String(regime||"UNKNOWN"),
      score:Number(score||0),
      opened_at:iso(),
      closed_at:null,
      entry_price:Number(signalPrice||0),
      exit_price:null,
      notional_usd:Number(notionalUsd||0),
      stop_price:null,
      target_price:null,
      status:"PENDING",
      outcome:null,
      metadata:{
        ...metadata,
        research_only:true,
        attempt_only:true,
        limit_price:Number(limitPrice||0),
        expires_at:Number(expiresAt||0)
      }
    };
    await db("strategy_trials","POST",{on_conflict:"trial_id"},row,{
      Prefer:"resolution=ignore-duplicates,return=minimal"
    });
    return row;
  }

  async function completeAttempt(attempt,{
    status,
    completedAt=iso(),
    details={}
  } = {}) {
    if(!attempt?.trial_id) throw new Error("attempt required");
    const nextStatus=String(status||"EXPIRED").toUpperCase();
    const merged={
      ...attempt,
      status:nextStatus,
      closed_at:completedAt,
      metadata:{...(attempt.metadata||{}),...details}
    };
    await db("strategy_trials","POST",{on_conflict:"trial_id"},merged,{
      Prefer:"resolution=merge-duplicates,return=minimal"
    });
    return merged;
  }

  async function loadPendingAttempts({ family, limit=10000 } = {}) {
    const params={status:"eq.PENDING",order:"opened_at.asc",limit:String(limit)};
    if(family) params.family="eq."+family;
    return db("strategy_trials","GET",params);
  }

  async function loadAttempts({ family, limit=10000 } = {}) {
    const perStatus=Math.max(1,Math.floor(Number(limit||10000)/3));
    const rows=(await Promise.all(["PENDING","FILLED","EXPIRED"].map(status=>{
      const params={status:"eq."+status,order:"opened_at.asc",limit:String(perStatus)};
      if(family) params.family="eq."+family;
      return db("strategy_trials","GET",params);
    }))).flat();
    return rows
      .filter(x=>x?.metadata?.attempt_only===true || String(x?.trial_id||"").startsWith("ATTEMPT:"))
      .sort((a,b)=>String(a.opened_at||"").localeCompare(String(b.opened_at||"")));
  }

  async function loadClosed({ family, limit=10000 } = {}) {
    const params={status:"eq.CLOSED",order:"closed_at.asc",limit:String(limit)};
    if (family) params.family="eq."+family;
    return db("strategy_trials","GET",params);
  }

  async function loadOpen({ family, limit=10000 } = {}) {
    const params={status:"eq.OPEN",order:"opened_at.asc",limit:String(limit)};
    if (family) params.family="eq."+family;
    return db("strategy_trials","GET",params);
  }

  async function accountingState({ initialEquityUsd=5000 } = {}) {
    const rows=await loadClosed({});
    const ordered=[...rows].sort((a,b)=>String(a.closed_at||"").localeCompare(String(b.closed_at||"")));
    let equityUsd=Number(initialEquityUsd||0);
    let peakEquityUsd=equityUsd;
    let realizedNetUsd=0;
    for(const row of ordered){
      const net=Number(row?.outcome?.netUsd);
      if(!Number.isFinite(net)) continue;
      realizedNetUsd+=net;
      equityUsd+=net;
      peakEquityUsd=Math.max(peakEquityUsd,equityUsd);
    }
    return {initialEquityUsd:Number(initialEquityUsd||0),equityUsd,peakEquityUsd,realizedNetUsd,closedCount:ordered.length};
  }

  function toTrade(x) {
    if (!x?.outcome?.valid) return null;
    return {
      family:x.family,
      symbol:x.symbol,
      regime:x.regime,
      side:x.side,
      openedAt:x.opened_at,
      closedAt:x.closed_at,
      netBps:x.outcome.netBps,
      grossBps:x.outcome.grossBps,
      costBps:x.outcome.costBps
    };
  }

  async function performance({ family, recentCount=100, foldCount=5 } = {}) {
    const rows=await loadClosed({family});
    const trades=rows.map(toTrade).filter(Boolean);
    return summarizeStrategyTrades(trades,{recentCount,foldCount});
  }

  async function performanceProfile({ recentCount=100, foldCount=5 } = {}) {
    const rows=await loadClosed({});
    const trades=rows.map(toTrade).filter(Boolean);
    return buildPerformanceProfile(trades,{recentCount,foldCount});
  }

  async function executionQualityProfile(options = {}) {
    const rows=await loadAttempts({});
    return buildExecutionQualityProfile(rows,options);
  }

  return {
    openTrial,closeTrial,recordAttempt,completeAttempt,
    loadPendingAttempts,loadAttempts,loadClosed,loadOpen,
    accountingState,performance,performanceProfile,executionQualityProfile
  };
}
