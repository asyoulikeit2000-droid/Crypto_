import { evaluateLiquidityReversion } from "./liquidity-reversion-v1.mjs";
import { evaluateTrendContinuation } from "./trend-continuation-v1.mjs";
import { classifyExecutionRegime } from "./regime-classifier.mjs";
import { evaluateStrategyPromotion } from "./performance-gate.mjs";

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
    const eligible = researchMode ? true : promotion.promoted;
    candidates.push({
      ...setup,
      promotion,
      eligible,
      rankScore: setup.score
        + Math.max(-15, Math.min(15, finite(performance[family]?.avgNetBps) * 0.75))
        + Math.max(-10, Math.min(10, (finite(performance[family]?.profitFactor, 1) - 1) * 10))
    });
  }

  const eligible = candidates
    .filter(x => x.eligible)
    .sort((a,b) => b.rankScore - a.rankScore);

  if (!eligible.length) {
    return {
      action: "NO_TRADE",
      regime,
      selected: null,
      candidates,
      reason: candidates.length ? "noPromotedStrategy" : "noSetup"
    };
  }

  const selected = eligible[0];
  return {
    action: selected.action,
    regime,
    selected,
    candidates,
    researchOnly: researchMode || !selected.promotion.promoted
  };
}
