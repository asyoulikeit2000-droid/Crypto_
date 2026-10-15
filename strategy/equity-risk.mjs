function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

export function drawdownRiskMultiplier(drawdownPct) {
  const dd = Math.max(0, finite(drawdownPct));
  if (dd >= 0.05) return 0;
  if (dd >= 0.035) return 0.50;
  if (dd >= 0.02) return 0.75;
  return 1;
}

export function confidenceRiskMultiplier(score) {
  const s = clamp(finite(score), 0, 100);
  if (s < 70) return 0;
  return 0.50 + ((s - 70) / 30) * 0.50;
}

export function sizePosition({
  equityUsd,
  peakEquityUsd,
  stopDistancePct,
  score,
  baseRiskPct = 0.002,
  maxNotionalEquityMultiple = 1,
  maxNotionalUsd = Infinity
} = {}) {
  const equity = finite(equityUsd);
  const peak = Math.max(equity, finite(peakEquityUsd, equity));
  const stopPct = finite(stopDistancePct);
  if (!(equity > 0) || !(stopPct > 0)) {
    return { allowed: false, reason: "invalidSizingInput" };
  }

  const drawdownPct = peak > 0 ? (peak - equity) / peak : 1;
  const ddMultiplier = drawdownRiskMultiplier(drawdownPct);
  const confidenceMultiplier = confidenceRiskMultiplier(score);
  if (ddMultiplier === 0) return { allowed: false, reason: "drawdownStop", drawdownPct };
  if (confidenceMultiplier === 0) return { allowed: false, reason: "scoreTooLow", drawdownPct };

  const riskUsd = equity * finite(baseRiskPct, 0.002) * ddMultiplier * confidenceMultiplier;
  const notionalByStop = riskUsd / stopPct;
  const equityCap = equity * finite(maxNotionalEquityMultiple, 1);
  const notionalUsd = Math.min(notionalByStop, equityCap, finite(maxNotionalUsd, Infinity));

  return {
    allowed: notionalUsd > 0,
    equityUsd: equity,
    drawdownPct,
    riskUsd,
    stopDistancePct: stopPct,
    notionalUsd,
    effectiveNotionalToEquity: notionalUsd / equity,
    ddMultiplier,
    confidenceMultiplier
  };
}
