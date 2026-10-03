import { routeStrategy } from "../strategy/router.mjs";
import { sizePosition } from "../strategy/equity-risk.mjs";

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
  reentryCooldownMs=5*60*1000,
  performanceRefreshMs=5*60*1000,
  onStatus=()=>{},
  setRepeater=setInterval,
  clearRepeater=clearInterval
} = {}) {
  if (!bridge?.features) throw new Error("Binance feature bridge required");
  if (!lab?.openTrial || !lab?.closeTrial || !lab?.performance) throw new Error("strategy lab required");

  const wanted=[...new Set(symbols.map(x=>String(x).toUpperCase()))];
  const open=new Map();
  const lastClosedAt=new Map();
  const performance={};
  let timer=null;
  let performanceTimer=null;
  let equityUsd=finite(initialEquityUsd,5000);
  let peakEquity=finite(peakEquityUsd,equityUsd);
  let started=false;

  function key(family,symbol){ return family+":"+symbol; }

  async function refreshPerformance() {
    for (const family of ["LIQUIDITY_REVERSION_V1","TREND_CONTINUATION_V1"]) {
      try {
        performance[family]=await lab.performance({family,recentCount:100,foldCount:5});
      } catch (error) {
        onStatus({event:"performanceError",family,error:String(error?.message||error),at:Date.now()});
      }
    }
    return performance;
  }

  function currentPrice(symbol) {
    return finite(bridge.features(symbol)?.price,null);
  }

  async function closeEligible() {
    const now=Date.now();
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
        researchMode:true
      });

      for (const candidate of routed.candidates || []) {
        const k=key(candidate.family,symbol);
        const lastExit=finite(lastClosedAt.get(k),0);
        if (open.has(k) || candidate.action==="NO_TRADE") continue;
        if (lastExit && Date.now()-lastExit < reentryCooldownMs) continue;

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
        const targets=priceTargets({
          side,
          entryPrice:features.price,
          stopDistancePct:plan.stopDistancePct,
          rewardRisk:plan.rewardRisk
        });
        const now=Date.now();

        try {
          const trial=await lab.openTrial({
            trialId:`${candidate.family}:${symbol}:${now}`,
            family:candidate.family,
            symbol,
            side,
            regime:routed.regime?.regime,
            score:candidate.score,
            entryPrice:features.price,
            notionalUsd:sizing.notionalUsd,
            stopPrice:targets.stopPrice,
            targetPrice:targets.targetPrice,
            metadata:{
              source:"BINANCE_PUBLIC_SHADOW",
              exchange:"BINANCE",
              research_only:true,
              stop_distance_pct:plan.stopDistancePct,
              reward_risk:plan.rewardRisk,
              risk_usd:sizing.riskUsd,
              equity_at_entry_usd:equityUsd,
              funding_rate:features.funding_rate,
              open_interest:features.open_interest,
              open_interest_change:features.open_interest_change,
              spread_bps:features.spread_bps,
              feature_snapshot:features
            }
          });
          open.set(k,{trial,openedAtMs:now});
          onStatus({
            event:"shadowOpened",
            family:candidate.family,
            symbol,
            side,
            score:candidate.score,
            regime:routed.regime?.regime,
            notionalUsd:sizing.notionalUsd,
            stopPrice:targets.stopPrice,
            targetPrice:targets.targetPrice,
            at:now
          });
        } catch (error) {
          onStatus({event:"openError",family:candidate.family,symbol,error:String(error?.message||error),at:now});
        }
      }
    }
  }

  async function tick() {
    await closeEligible();
    await openCandidates();
    onStatus({
      event:"shadowHeartbeat",
      openTrials:open.size,
      equityUsd,
      peakEquityUsd:peakEquity,
      at:Date.now()
    });
  }

  async function start() {
    if (started) return;
    started=true;
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
    start,stop,tick,refreshPerformance,
    state:()=>({
      started,
      symbols:wanted,
      openTrials:[...open.values()].map(x=>x.trial),
      cooldowns:Object.fromEntries([...lastClosedAt.entries()]),
      performance:{...performance},
      equityUsd,
      peakEquityUsd:peakEquity
    })
  };
}
