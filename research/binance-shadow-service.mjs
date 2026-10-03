import { createIntelligenceEngine } from "../intelligence-engine.mjs";
import { createBinanceUsdmFeed } from "../market/binance-usdm-feed.mjs";
import { createBinanceFeatureBridge } from "../market/binance-feature-bridge.mjs";
import { createStrategyLab } from "./strategy-lab.mjs";
import { createBinanceShadowRunner } from "./binance-shadow-runner.mjs";

const DEFAULT_SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT"];

function parseSymbols(value) {
  const raw=String(value||"").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
  return raw.length ? [...new Set(raw)] : DEFAULT_SYMBOLS;
}

export function defaultShadowCostAssumptions(env=process.env) {
  return {
    entryFeeRate:Number(env.SHADOW_ENTRY_FEE_RATE || 0.0002),
    exitFeeRate:Number(env.SHADOW_EXIT_FEE_RATE || 0.0005),
    entrySlippageBps:Number(env.SHADOW_ENTRY_SLIPPAGE_BPS || 0.5),
    exitSlippageBps:Number(env.SHADOW_EXIT_SLIPPAGE_BPS || 1),
    spreadCrossingBps:Number(env.SHADOW_SPREAD_CROSSING_BPS || 0.5),
    fundingRateAbs:Number(env.SHADOW_FUNDING_RATE_ABS || 0),
    expectedFundingPeriods:Number(env.SHADOW_EXPECTED_FUNDING_PERIODS || 0)
  };
}

export function createBinanceShadowService({
  db,
  markHealth=async()=>{},
  env=process.env,
  WebSocketImpl=globalThis.WebSocket,
  fetchImpl=globalThis.fetch,
  onStatus=()=>{}
} = {}) {
  if (typeof db !== "function") throw new Error("db required");

  const symbols=parseSymbols(env.SHADOW_SYMBOLS);
  const intelligence=createIntelligenceEngine();
  const bridge=createBinanceFeatureBridge({intelligence});
  const costAssumptions=defaultShadowCostAssumptions(env);
  const lab=createStrategyLab({db,costAssumptions});

  let lastFeedStatus=null;
  let lastRunnerStatus=null;

  async function emitStatus(source,status) {
    const row={source,...status};
    if (source==="feed") lastFeedStatus=row;
    if (source==="runner") lastRunnerStatus=row;
    try {
      await markHealth("binance-shadow-research",
        status?.healthy===false ? "DEGRADED" : "OK",
        {
          source,
          symbols,
          feed:lastFeedStatus,
          runner:lastRunnerStatus,
          research_only:true
        }
      );
    } catch {}
    onStatus(row);
  }

  const feed=createBinanceUsdmFeed({
    symbols,
    WebSocketImpl,
    fetchImpl,
    onTrade:bridge.onTrade,
    onBook:bridge.onBook,
    onMark:bridge.onMark,
    onOpenInterest:bridge.onOpenInterest,
    onStatus:s=>emitStatus("feed",s)
  });

  const runner=createBinanceShadowRunner({
    symbols,
    bridge,
    lab,
    initialEquityUsd:Number(env.SHADOW_INITIAL_EQUITY_USD || 5000),
    peakEquityUsd:Number(env.SHADOW_INITIAL_EQUITY_USD || 5000),
    baseRiskPct:Number(env.SHADOW_BASE_RISK_PCT || 0.002),
    maxNotionalUsd:Number(env.SHADOW_MAX_NOTIONAL_USD || 5000),
    maxNotionalEquityMultiple:Number(env.SHADOW_MAX_NOTIONAL_EQUITY_MULTIPLE || 1),
    evaluationMs:Number(env.SHADOW_EVALUATION_MS || 15000),
    maxHoldMs:Number(env.SHADOW_MAX_HOLD_MS || 5400000),
    performanceRefreshMs:Number(env.SHADOW_PERFORMANCE_REFRESH_MS || 300000),
    onStatus:s=>emitStatus("runner",s)
  });

  async function start() {
    await markHealth("binance-shadow-research","STARTING",{symbols,research_only:true});
    feed.start();
    await runner.start();
    await markHealth("binance-shadow-research","OK",{symbols,research_only:true});
    return state();
  }

  async function stop() {
    runner.stop();
    feed.stop();
    await markHealth("binance-shadow-research","STOPPED",{symbols,research_only:true});
  }

  function state() {
    return {
      mode:"SHADOW_RESEARCH_ONLY",
      liveOrdersPossible:false,
      symbols,
      costAssumptions,
      feed:feed.status(),
      runner:runner.state(),
      lastFeedStatus,
      lastRunnerStatus
    };
  }

  return {start,stop,state,feed,runner,bridge,lab};
}
