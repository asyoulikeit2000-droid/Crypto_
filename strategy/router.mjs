import { evaluateLiquidityReversion } from "./liquidity-reversion-v1.mjs";
import { evaluateTrendContinuation } from "./trend-continuation-v1.mjs";
import { classifyExecutionRegime } from "./regime-classifier.mjs";
import { evaluateStrategyPromotion } from "./performance-gate.mjs";
import { evaluateContextEvidence } from "./context-evidence.mjs";
import { evaluateExecutionQuality } from "../research/execution-quality.mjs";

const STRATEGIES = Object.freeze({
  LIQUIDITY_REVERSION_V1: evaluateLiquidityReversion,
  TREND_CONTINUATION_V1: evaluateTrendContinuation
});

function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function routeStrategy({
  features,
  btcFeatures,
  performance = {},
  performanceProfile = {},
  executionQualityProfile = {},
  policy = {},
  researchMode = true
} = {}) {
  const regime = classifyExecutionRegime(features, btcFeatures);
  if (regime.regime === "UNTRADEABLE" || regime.regime === "HIGH_VOL") {
    return {
      action: "NO_TRADE",
      regime,
      selected: null,
      candidates: [],
      reason: "regimeBlocked"
    };
  }

  const candidates = [];
  for (const [family, evaluate] of Object.entries(STRATEGIES)) {
    const setup = evaluate(features, {
      regime: regime.regime,
      regimeConfidence: regime.confidence,
      maxSpreadBps: finite(policy.maxSpreadBps, 4)
    });
    if (setup.action === "NO_TRADE") continue;

    const promotion = evaluateStrategyPromotion(performance[family] || {}, policy.promotion || {});
    const contextEvidence = evaluateContextEvidence(performanceProfile,{
      family,
      symbol:features?.symbol,
      regime:regime.regime
    },policy.context || {});
    const executionKey=`${family}|${String(features?.symbol||"UNKNOWN").toUpperCase()}|${regime.regime}`;
    const executionStats=executionQualityProfile?.contexts?.[executionKey] || {};
    const executionQuality=evaluateExecutionQuality(executionStats,policy.execution || {});
    const executionReady=executionQuality.status==="HEALTHY";
    const eligible = researchMode
      ? !contextEvidence.researchBlocked
      : promotion.promoted && contextEvidence.executionEligible && executionReady;
    candidates.push({
      ...setup,
      promotion,
      contextEvidence,
      executionQuality,
      executionReady,
      eligible,
      rankScore: setup.score
        + Math.max(-15, Math.min(15, finite(performance[family]?.avgNetBps) * 0.75))
        + Math.max(-10, Math.min(10, (finite(performance[family]?.profitFactor, 1) - 1) * 10))
        + Math.max(-12, Math.min(12, finite(contextEvidence.contextScore) * 0.5))
    });
  }

  const eligible = candidates
    .filter(x => x.eligible)
    .sort((a,b) => b.rankScore - a.rankScore);

  if (!eligible.length) {
    let reason="noSetup";
    if (candidates.length) {
      if (researchMode) reason="contextDegraded";
      else if (candidates.every(x=>!x.promotion.promoted)) reason="noPromotedStrategy";
      else if (candidates.some(x=>x.promotion.promoted && x.contextEvidence?.executionEligible && !x.executionReady)) reason="executionQualityUnproven";
      else reason="noContextEvidence";
    }
    return {
      action: "NO_TRADE",
      regime,
      selected: null,
      candidates,
      reason
    };
  }

  const selected = eligible[0];
  return {
    action: selected.action,
    regime,
    selected,
    candidates,
    researchOnly: researchMode || !selected.promotion.promoted || !selected.contextEvidence.executionEligible || !selected.executionReady
  };
}
