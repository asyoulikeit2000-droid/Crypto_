function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function lowerConfidenceMeanBps(stats = {}) {
  const n = Math.max(0, Math.floor(finite(stats.sampleCount)));
  const mean = finite(stats.avgNetBps);
  const sd = Math.max(0, finite(stats.netBpsStdDev));
  if (n < 2) return -Infinity;
  return mean - 1.96 * (sd / Math.sqrt(n));
}

export function evaluateStrategyPromotion(stats = {}, policy = {}) {
  const failed = [];
  const minSamples = Math.max(30, Math.floor(finite(policy.minSamples, 200)));
  const minRecentSamples = Math.max(20, Math.floor(finite(policy.minRecentSamples, 50)));
  const minProfitFactor = finite(policy.minProfitFactor, 1.20);
  const minPositiveFoldRatio = finite(policy.minPositiveFoldRatio, 0.60);
  const maxDrawdownPct = finite(policy.maxDrawdownPct, 0.05);
  const minAvgNetBps = finite(policy.minAvgNetBps, 2);

  const n = Math.max(0, Math.floor(finite(stats.sampleCount)));
  const recentN = Math.max(0, Math.floor(finite(stats.recentSampleCount)));
  const foldCount = Math.max(0, Math.floor(finite(stats.foldCount)));
  const positiveFolds = Math.max(0, Math.floor(finite(stats.positiveFolds)));
  const positiveFoldRatio = foldCount ? positiveFolds / foldCount : 0;
  const lcb = lowerConfidenceMeanBps(stats);

  if (n < minSamples) failed.push("sampleCount");
  if (recentN < minRecentSamples) failed.push("recentSampleCount");
  if (finite(stats.avgNetBps) < minAvgNetBps) failed.push("avgNetBps");
  if (finite(stats.recentAvgNetBps) <= 0) failed.push("recentAvgNetBps");
  if (finite(stats.profitFactor) < minProfitFactor) failed.push("profitFactor");
  if (positiveFoldRatio < minPositiveFoldRatio) failed.push("walkForwardFolds");
  if (finite(stats.maxDrawdownPct, Infinity) > maxDrawdownPct) failed.push("maxDrawdown");
  if (!(lcb > 0)) failed.push("confidenceBound");
  if (finite(stats.costCoverageRatio) < 1) failed.push("costCoverage");
  if (finite(stats.symbolConcentrationPct, 1) > finite(policy.maxSymbolConcentrationPct, 0.60)) failed.push("symbolConcentration");

  return {
    promoted: failed.length === 0,
    failed,
    diagnostics: {
      sampleCount: n,
      recentSampleCount: recentN,
      positiveFoldRatio,
      lowerConfidenceMeanBps: lcb
    }
  };
}
