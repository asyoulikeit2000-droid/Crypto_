import { routeStrategy } from "../strategy/router.mjs";
import { sizePosition } from "../strategy/equity-risk.mjs";
import { rankStrategyContexts } from "./context-ranking.mjs";
import { buildMakerOrder, evaluateMakerFill } from "./maker-fill-model.mjs";

function finite(v, fallback = 0) {
  const n=Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(x,a,b){ return Math.max(a,Math.min(b,x)); }

export function stopPlan(features = {}, family = "") {
  const r5=Math.abs(finite(features.return_5m));
  const rv=Math.abs(finite(features.realized_vol));
  const spreadPct=Math.max(0,finite(features.spread_bps))/10_000;
  const raw=Math.max(
    family === "LIQUIDITY_REVERSION_V1" ? 0.0025 : 0.0030,
    r5 * (family === "LIQUIDITY_REVERSION_V1" ? 0.55 : 0.45),
    rv * 1.2,
    spreadPct * 5
  );
  const stopDistancePct=clamp(raw,0.0025,0.008);
  const rewardRisk=family === "TREND_CONTINUATION_V1" ? 1.8 : 1.5;
  return {stopDistancePct,rewardRisk};
}

export function priceTargets({side,entryPrice,stopDistancePct,rewardRisk}) {
  const entry=finite(entryPrice);
  const stopPct=finite(stopDistancePct);
  const rr=finite(rewardRisk,1.5);
  const dir=String(side).toUpperCase()==="SELL" ? -1 : 1;
  return {
    stopPrice:entry * (1 - dir * stopPct),
    targetPrice:entry * (1 + dir * stopPct * rr)
  };
}

export function createBinanceShadowRunner({
  symbols=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT"],
  bridge,
  lab,
  initialEquityUsd=5_000,
  peakEquityUsd=5_000,
  baseRiskPct=0.002,
  maxNotionalUsd=5_000,
  maxNotionalEquityMultiple=1,
  evaluationMs=15_000,
  maxHoldMs=90*60*1000,
  performanceRefreshMs=5*60*1000,
  reentryCooldownMs=5*60*1000,
  makerOrderTtlMs=30_000,
  attemptCooldownMs=60_000,
  queueAheadFraction=0.5,
  onStatus=()=>{},
  setRepeater=setInterval,
  clearRepeater=clearInterval
} = {}) {
  if (!bridge?.features || typeof bridge.tradesSince !== "function") throw new Error("Binance feature bridge with trade history required");
  if (!lab?.openTrial || !lab?.closeTrial || !lab?.performance || !lab?.recordAttempt || !lab?.completeAttempt) {
    throw new Error("strategy lab with attempt persistence required");
  }

  const wanted=[...new Set(symbols.map(x=>String(x).toUpperCase()))];
  const open=new Map();
  const pending=new Map();
  const lastClosedAt=new Map();
  const lastAttemptAt=new Map();
  const performance={};
  let performanceProfile={};
  let executionQualityProfile={};
  let rankings=[];
  let timer=null;
  let performanceTimer=null;
  let equityUsd=finite(initialEquityUsd,5000);
  let peakEquity=finite(peakEquityUsd,equityUsd);
  let started=false;
  const fillStats={placed:0,filled:0,expired:0};

  function key(family,symbol){ return family+":"+symbol; }

  async function restoreState() {
    try {
      if (typeof lab.accountingState === "function") {
        const accounting=await lab.accountingState({initialEquityUsd});
        equityUsd=finite(accounting?.equityUsd,initialEquityUsd);
        peakEquity=Math.max(equityUsd,finite(accounting?.peakEquityUsd,equityUsd));
      }

      if (typeof lab.loadOpen === "function") {
        const rows=await lab.loadOpen({});
        for (const trial of rows || []) {
          if (!trial?.family || !trial?.symbol || !trial?.trial_id) continue;
          const k=key(trial.family,trial.symbol);
          if (open.has(k)) {
            onStatus({event:"recoveryDuplicateOpen",key:k,trialId:trial.trial_id,at:Date.now()});
            continue;
          }
          const openedAtMs=Date.parse(trial.opened_at);
          open.set(k,{
            trial,
            openedAtMs:Number.isFinite(openedAtMs)?openedAtMs:Date.now()
          });
        }
      }

      if (typeof lab.loadPendingAttempts === "function") {
        const attempts=await lab.loadPendingAttempts({});
        for (const attempt of attempts || []) {
          const order=attempt?.metadata?.maker_order;
          if (!order?.valid || !attempt?.family || !attempt?.symbol) {
            await lab.completeAttempt(attempt,{
              status:"EXPIRED",
              details:{completion_reason:"invalidRecoveredAttempt"}
            });
            continue;
          }
          const k=key(attempt.family,attempt.symbol);
          if (open.has(k) || pending.has(k)) {
            await lab.completeAttempt(attempt,{
              status:"EXPIRED",
              details:{completion_reason:"duplicateRecoveredAttempt"}
            });
            continue;
          }
          if (Date.now() >= finite(order.expiresAt)) {
            await lab.completeAttempt(attempt,{
              status:"EXPIRED",
              details:{completion_reason:"expiredDuringRestart"}
            });
            fillStats.expired++;
            lastAttemptAt.set(k,finite(order.submittedAt,Date.now()));
            continue;
          }
          pending.set(k,{attempt,order});
          fillStats.placed++;
          lastAttemptAt.set(k,finite(order.submittedAt,Date.now()));
        }
      }

      onStatus({
        event:"shadowRecovered",
        openTrials:open.size,
        pendingOrders:pending.size,
        equityUsd,
        peakEquityUsd:peakEquity,
        at:Date.now()
      });
    } catch (error) {
      onStatus({event:"recoveryError",error:String(error?.message||error),at:Date.now()});
      throw error;
    }
  }

  async function refreshPerformance() {
    try {
      if (typeof lab.performanceProfile === "function") {
        performanceProfile=await lab.performanceProfile({recentCount:100,foldCount:5});
        for (const family of ["LIQUIDITY_REVERSION_V1","TREND_CONTINUATION_V1"]) {
          performance[family]=performanceProfile?.families?.[family] || {};
        }
        if (typeof lab.executionQualityProfile === "function") {
          executionQualityProfile=await lab.executionQualityProfile({minThroughputWindowHours:6});
        }
        rankings=rankStrategyContexts(performanceProfile,executionQualityProfile);
        onStatus({
          event:"researchRanking",
          sampleCount:performanceProfile?.sampleCount || 0,
          attemptCount:executionQualityProfile?.attempts?.attemptCount || 0,
          completedAttemptCount:executionQualityProfile?.attempts?.completedCount || 0,
          fillRate:executionQualityProfile?.attempts?.fillRate ?? null,
          filledPerDay:executionQualityProfile?.attempts?.filledPerDay || 0,
          top:rankings.slice(0,10),
          at:Date.now()
        });
      } else {
        for (const family of ["LIQUIDITY_REVERSION_V1","TREND_CONTINUATION_V1"]) {
          performance[family]=await lab.performance({family,recentCount:100,foldCount:5});
        }
      }
    } catch (error) {
      onStatus({event:"performanceError",error:String(error?.message||error),at:Date.now()});
    }
    return performance;
  }

  function currentPrice(symbol) {
    return finite(bridge.features(symbol)?.price,null);
  }

  async function closeEligible() {
    const now=Date.now();
    let closedAny=false;
    for (const [k,state] of [...open.entries()]) {
      const price=currentPrice(state.trial.symbol);
      if (!(price>0)) continue;
      const long=state.trial.side==="BUY";
      const stopHit=long ? price<=state.trial.stop_price : price>=state.trial.stop_price;
      const targetHit=long ? price>=state.trial.target_price : price<=state.trial.target_price;
      const expired=now-state.openedAtMs>=maxHoldMs;
      if (!stopHit && !targetHit && !expired) continue;

      const exitReason=stopHit ? "STOP" : targetHit ? "TARGET" : "TIME";
      try {
        const closed=await lab.closeTrial(state.trial,{
          exitPrice:price,
          exitReason,
          closedAt:new Date(now).toISOString()
        });
        open.delete(k);
        lastClosedAt.set(k,now);
        equityUsd += finite(closed?.outcome?.netUsd);
        peakEquity=Math.max(peakEquity,equityUsd);
        closedAny=true;
        onStatus({
          event:"shadowClosed",
          family:closed.family,
          symbol:closed.symbol,
          exitReason,
          netUsd:closed.outcome?.netUsd,
          netBps:closed.outcome?.netBps,
          equityUsd,
          at:now
        });
      } catch (error) {
        onStatus({event:"closeError",key:k,error:String(error?.message||error),at:now});
      }
    }
    return closedAny;
  }

  async function evaluatePending() {
    const now=Date.now();
    for (const [k,state] of [...pending.entries()]) {
      const trades=bridge.tradesSince(state.order.symbol,state.order.submittedAt);
      const result=evaluateMakerFill(state.order,trades,now);
      if (result.status==="PENDING") continue;

      if (result.status==="EXPIRED") {
        await lab.completeAttempt(state.attempt,{
          status:"EXPIRED",
          completedAt:new Date(now).toISOString(),
          details:{
            completion_reason:result.reason,
            observed_opposing_qty:result.observedOpposingQty,
            required_fill_qty:result.thresholdQty
          }
        });
        pending.delete(k);
        lastAttemptAt.set(k,now);
        fillStats.expired++;
        onStatus({
          event:"shadowOrderExpired",
          family:state.order.family,
          symbol:state.order.symbol,
          side:state.order.side,
          limitPrice:state.order.limitPrice,
          at:now
        });
        continue;
      }

      if (result.status==="FILLED") {
        const targets=priceTargets({
          side:state.order.side,
          entryPrice:result.fillPrice,
          stopDistancePct:state.order.stopDistancePct,
          rewardRisk:state.order.rewardRisk
        });

        await lab.completeAttempt(state.attempt,{
          status:"FILLED",
          completedAt:new Date(result.fillAt||now).toISOString(),
          details:{
            completion_reason:result.reason,
            fill_price:result.fillPrice,
            fill_at:result.fillAt,
            fill_latency_ms:result.latencyMs,
            observed_opposing_qty:result.observedOpposingQty,
            required_fill_qty:result.thresholdQty
          }
        });

        const trial=await lab.openTrial({
          trialId:`TRADE:${state.order.family}:${state.order.symbol}:${state.order.submittedAt}`,
          family:state.order.family,
          symbol:state.order.symbol,
          side:state.order.side,
          regime:state.order.regime,
          score:state.order.score,
          entryPrice:result.fillPrice,
          notionalUsd:state.order.notionalUsd,
          stopPrice:targets.stopPrice,
          targetPrice:targets.targetPrice,
          metadata:{
            ...(state.attempt.metadata||{}),
            attempt_id:state.attempt.trial_id,
            entry_fill_type:"MAKER_SIMULATED",
            signal_price:state.order.signalPrice,
            maker_limit_price:state.order.limitPrice,
            fill_reason:result.reason,
            fill_latency_ms:result.latencyMs,
            observed_opposing_qty:result.observedOpposingQty,
            required_fill_qty:result.thresholdQty
          }
        });

        pending.delete(k);
        open.set(k,{trial,openedAtMs:finite(result.fillAt,now)});
        lastAttemptAt.set(k,now);
        fillStats.filled++;

        onStatus({
          event:"shadowOpened",
          family:trial.family,
          symbol:trial.symbol,
          side:trial.side,
          score:trial.score,
          regime:trial.regime,
          notionalUsd:trial.notional_usd,
          entryPrice:trial.entry_price,
          stopPrice:trial.stop_price,
          targetPrice:trial.target_price,
          fillLatencyMs:result.latencyMs,
          at:now
        });
      }
    }
  }

  async function openCandidates() {
    const btcFeatures=bridge.features("BTCUSDT");
    for (const symbol of wanted) {
      const features=bridge.features(symbol);
      if (!features?.data_fresh || !features?.microstructure_quality || !(features.price>0)) continue;

      const routed=routeStrategy({
        features,
        btcFeatures:symbol==="BTCUSDT" ? features : btcFeatures,
        performance,
        performanceProfile,
        executionQualityProfile,
        researchMode:true
      });

      for (const candidate of routed.candidates || []) {
        const k=key(candidate.family,symbol);
        const lastExit=finite(lastClosedAt.get(k),0);
        const lastAttempt=finite(lastAttemptAt.get(k),0);
        if (open.has(k) || pending.has(k) || candidate.action==="NO_TRADE") continue;
        if (lastExit && Date.now()-lastExit < reentryCooldownMs) continue;
        if (lastAttempt && Date.now()-lastAttempt < attemptCooldownMs) continue;

        const plan=stopPlan(features,candidate.family);
        const sizing=sizePosition({
          equityUsd,
          peakEquityUsd:peakEquity,
          stopDistancePct:plan.stopDistancePct,
          score:candidate.score,
          baseRiskPct,
          maxNotionalEquityMultiple,
          maxNotionalUsd
        });
        if (!sizing.allowed) continue;

        const side=candidate.action==="BUY" ? "BUY" : "SELL";
        const now=Date.now();
        const order=buildMakerOrder({
          family:candidate.family,
          symbol,
          side,
          regime:routed.regime?.regime,
          score:candidate.score,
          features,
          notionalUsd:sizing.notionalUsd,
          stopDistancePct:plan.stopDistancePct,
          rewardRisk:plan.rewardRisk,
          submittedAt:now,
          ttlMs:makerOrderTtlMs,
          queueAheadFraction
        });
        if (!order.valid) {
          onStatus({event:"makerOrderRejected",family:candidate.family,symbol,reason:order.reason,at:now});
          continue;
        }

        try {
          const attempt=await lab.recordAttempt({
            attemptId:`ATTEMPT:${candidate.family}:${symbol}:${now}`,
            family:candidate.family,
            symbol,
            side,
            regime:routed.regime?.regime,
            score:candidate.score,
            signalPrice:features.price,
            limitPrice:order.limitPrice,
            notionalUsd:sizing.notionalUsd,
            expiresAt:order.expiresAt,
            metadata:{
              source:"BINANCE_PUBLIC_SHADOW",
              exchange:"BINANCE",
              research_only:true,
              maker_order:order,
              stop_distance_pct:plan.stopDistancePct,
              reward_risk:plan.rewardRisk,
              risk_usd:sizing.riskUsd,
              equity_at_signal_usd:equityUsd,
              funding_rate:features.funding_rate,
              open_interest:features.open_interest,
              open_interest_change:features.open_interest_change,
              spread_bps:features.spread_bps,
              feature_snapshot:features,
              context_evidence:{
                status:candidate.contextEvidence?.status,
                reasons:candidate.contextEvidence?.reasons,
                shrunk_net_bps:candidate.contextEvidence?.shrunkNetBps,
                execution_eligible:candidate.contextEvidence?.executionEligible
              }
            }
          });

          pending.set(k,{attempt,order});
          lastAttemptAt.set(k,now);
          fillStats.placed++;
          onStatus({
            event:"shadowOrderPlaced",
            family:candidate.family,
            symbol,
            side,
            score:candidate.score,
            regime:routed.regime?.regime,
            notionalUsd:sizing.notionalUsd,
            signalPrice:features.price,
            limitPrice:order.limitPrice,
            expiresAt:order.expiresAt,
            queueAheadQty:order.queueAheadQty,
            orderQty:order.orderQty,
            at:now
          });
        } catch (error) {
          onStatus({event:"openError",family:candidate.family,symbol,error:String(error?.message||error),at:now});
        }
      }
    }
  }

  async function tick() {
    const closedAny=await closeEligible();
    if (closedAny) await refreshPerformance();
    await evaluatePending();
    await openCandidates();
    onStatus({
      event:"shadowHeartbeat",
      openTrials:open.size,
      pendingOrders:pending.size,
      fillStats:{...fillStats},
      equityUsd,
      peakEquityUsd:peakEquity,
      at:Date.now()
    });
  }

  async function start() {
    if (started) return;
    started=true;
    await restoreState();
    await refreshPerformance();
    await tick();
    timer=setRepeater(()=>tick().catch(error=>onStatus({event:"tickError",error:String(error?.message||error),at:Date.now()})),evaluationMs);
    performanceTimer=setRepeater(()=>refreshPerformance(),performanceRefreshMs);
  }

  function stop() {
    started=false;
    if (timer) clearRepeater(timer);
    if (performanceTimer) clearRepeater(performanceTimer);
    timer=performanceTimer=null;
  }

  return {
    start,stop,tick,restoreState,refreshPerformance,
    state:()=>({
      started,
      symbols:wanted,
      openTrials:[...open.values()].map(x=>x.trial),
      pendingOrders:[...pending.values()].map(x=>x.order),
      cooldowns:Object.fromEntries([...lastClosedAt.entries()]),
      performance:{...performance},
      performanceProfile,
      executionQualityProfile,
      rankings:[...rankings],
      fillStats:{...fillStats},
      equityUsd,
      peakEquityUsd:peakEquity
    })
  };
}
