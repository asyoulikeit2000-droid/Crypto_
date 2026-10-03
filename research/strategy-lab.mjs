import { summarizeStrategyTrades } from "../strategy/performance-metrics.mjs";
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
    closedAt = iso()
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
      outcome
    };
    await db("strategy_trials","POST",{on_conflict:"trial_id"},merged,{
      Prefer:"resolution=merge-duplicates,return=minimal"
    });
    return merged;
  }

  async function loadClosed({ family, limit=10000 } = {}) {
    const params={status:"eq.CLOSED",order:"closed_at.asc",limit:String(limit)};
    if (family) params.family="eq."+family;
    return db("strategy_trials","GET",params);
  }

  async function performance({ family, recentCount=100, foldCount=5 } = {}) {
    const rows=await loadClosed({family});
    const trades=rows
      .filter(x=>x.outcome?.valid)
      .map(x=>({
        family:x.family,
        symbol:x.symbol,
        openedAt:x.opened_at,
        closedAt:x.closed_at,
        netBps:x.outcome.netBps,
        grossBps:x.outcome.grossBps,
        costBps:x.outcome.costBps
      }));
    return summarizeStrategyTrades(trades,{recentCount,foldCount});
  }

  return { openTrial, closeTrial, loadClosed, performance };
}
