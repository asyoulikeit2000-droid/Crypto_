import { routeStrategy } from "../strategy/router.mjs";
import { sizePosition } from "../strategy/equity-risk.mjs";
import { evaluatePortfolioAdmission } from "../strategy/portfolio-guard.mjs";
import { estimateRoundTripCosts } from "./cost-model.mjs";
import { evaluateTradeIntent } from "./risk-engine.mjs";
import { evaluateVenueAlignment } from "./venue-policy.mjs";

function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function buildTradeDecision({
  symbol,
  features,
  btcFeatures,
  performance,
  account,
  portfolio,
  market,
  config,
  costAssumptions,
  stopDistancePct,
  researchMode = false,
  policy = {}
} = {}) {
  const route = routeStrategy({
    features,
    btcFeatures,
    performance,
    policy,
    researchMode
  });

  if (route.action === "NO_TRADE" || !route.selected) {
    return { allowed:false, stage:"strategy", reason:route.reason || "noStrategy", route };
  }

  const stats = performance?.[route.selected.family] || {};
  const conservativeNetBps = finite(route.selected?.promotion?.diagnostics?.lowerConfidenceMeanBps, -Infinity);
  if (!researchMode && !(conservativeNetBps > 0)) {
    return { allowed:false, stage:"edge", reason:"noConservativeEdge", route };
  }

  const sizing = sizePosition({
    equityUsd: account?.equityUsd,
    peakEquityUsd: account?.peakEquityUsd,
    stopDistancePct,
    score: route.selected.score,
    baseRiskPct: finite(policy.baseRiskPct, 0.002),
    maxNotionalEquityMultiple: finite(policy.maxNotionalEquityMultiple, 1),
    maxNotionalUsd: finite(config?.maxNotionalUsd, 0)
  });
  if (!sizing.allowed) {
    return { allowed:false, stage:"sizing", reason:sizing.reason, route, sizing };
  }

  const costs = estimateRoundTripCosts({
    ...costAssumptions,
    notionalUsd: sizing.notionalUsd
  });
  const costBps = sizing.notionalUsd > 0 ? costs.totalCostsUsd / sizing.notionalUsd * 10_000 : Infinity;
  const netBpsForPlanning = researchMode
    ? Math.max(0, finite(stats.avgNetBps))
    : conservativeNetBps;
  if (!(netBpsForPlanning > 0)) {
    return { allowed:false, stage:"edge", reason:"nonPositivePlanningEdge", route, sizing, costs };
  }

  const expectedGrossBps = netBpsForPlanning + costBps;
  const expectedGrossUsd = sizing.notionalUsd * expectedGrossBps / 10_000;
  const expectedNetUsd = expectedGrossUsd - costs.totalCostsUsd;
  const side = route.action === "BUY" ? "BUY" : "SELL";

  const venue = evaluateVenueAlignment({
    executionExchange: config?.exchange,
    marketExchange: market?.exchange,
    bookExchange: market?.bookExchange || market?.exchange,
    crossVenueAllowed:false
  });
  if (!venue.allowed) {
    return { allowed:false, stage:"venue", reason:"venueMismatch", route, sizing, costs, venue };
  }

  const portfolioAdmission = evaluatePortfolioAdmission({
    symbol,
    side,
    notionalUsd:sizing.notionalUsd
  }, {
    equityUsd:account?.equityUsd,
    positions:portfolio?.positions || []
  }, {
    maxOpenPositions:config?.maxOpenPositions,
    maxDirectionalNotionalPct:finite(policy.maxDirectionalNotionalPct, 1.25)
  });
  if (!portfolioAdmission.allowed) {
    return { allowed:false, stage:"portfolio", reason:"portfolioLimit", route, sizing, costs, venue, portfolioAdmission };
  }

  const riskPerStopUsd = sizing.riskUsd;
  const rewardRisk = finite(policy.rewardRisk, 1.5);
  const configuredMaxLeverage = Math.max(1, finite(config?.maxLeverage, 1));
  const preferredLeverage = Math.max(1, finite(policy.preferredLeverage, 2));
  const executionLeverage = Math.min(configuredMaxLeverage, preferredLeverage);

  const intent = {
    symbol,
    side,
    requestedNotionalUsd:sizing.notionalUsd,
    effectiveLeverage: executionLeverage,
    notionalToEquity: sizing.notionalUsd / Math.max(1, finite(account?.equityUsd)),
    expectedGrossUsd,
    expectedNetUsd,
    maxLossAtStopUsd:riskPerStopUsd,
    rewardRisk,
    strategyFamily:route.selected.family,
    conservativeNetBps:netBpsForPlanning
  };

  const risk = evaluateTradeIntent(intent, account, market, config);
  return {
    allowed: venue.allowed && portfolioAdmission.allowed && risk.allowed,
    stage: risk.allowed ? "approved" : "risk",
    reason: risk.allowed ? "approved" : "riskRejected",
    route,
    sizing,
    costs,
    venue,
    portfolioAdmission,
    intent,
    risk
  };
}
