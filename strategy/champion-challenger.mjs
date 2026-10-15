import { evaluateStrategyPromotion } from "./performance-gate.mjs";

function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function selectChampion(performanceByFamily = {}, policy = {}) {
  const evaluated = Object.entries(performanceByFamily).map(([family, stats]) => {
    const promotion = evaluateStrategyPromotion(stats, policy.promotion || {});
    const conservativeScore =
      finite(stats.avgNetBps) * 0.35 +
      finite(stats.recentAvgNetBps) * 0.25 +
      Math.max(-20, Math.min(20, (finite(stats.profitFactor, 1) - 1) * 12)) +
      Math.max(-20, Math.min(20, promotion.diagnostics.lowerConfidenceMeanBps)) -
      finite(stats.maxDrawdownPct) * 100 * 0.75;
    return { family, stats, promotion, conservativeScore };
  }).sort((a,b)=>b.conservativeScore-a.conservativeScore);

  const promoted = evaluated.filter(x=>x.promotion.promoted);
  if (!promoted.length) {
    return { champion:null, challengers:evaluated, reason:"noPromotedStrategy" };
  }

  const champion = promoted[0];
  const minLeadBps = finite(policy.minChampionLeadBps, 0.5);
  const second = promoted[1] || null;
  const stableLead = !second || champion.conservativeScore - second.conservativeScore >= minLeadBps;

  return {
    champion: stableLead ? champion : null,
    provisionalLeader: champion,
    challengers:evaluated,
    reason: stableLead ? "promotedChampion" : "leaderTooClose"
  };
}
