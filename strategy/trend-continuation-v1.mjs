function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }

export function evaluateTrendContinuation(features = {}, context = {}) {
  const regime = String(context.regime || "MIXED").toUpperCase();
  const r1 = finite(features.return_1m);
  const r5 = finite(features.return_5m);
  const r15 = finite(features.return_15m);
  const cvd2 = finite(features.cvd_2m);
  const cvd10 = finite(features.cvd_10m);
  const imbalance = finite(features.orderbook_imbalance);
  const spread = finite(features.spread_bps, Infinity);
  const blocked = [];
  const reasons = [];

  if (features.data_fresh !== true || features.microstructure_quality !== true) blocked.push("marketQuality");
  if (spread > finite(context.maxSpreadBps, 4)) blocked.push("spread");
  if (!["TREND_UP","TREND_DOWN"].includes(regime)) blocked.push("wrongRegime");

  let side = null;
  let score = 0;

  if (regime === "TREND_UP") {
    const persistent = r15 >= 0.002 && r5 >= 0.0007;
    const notOverextended = r5 <= 0.0045;
    const flow = cvd10 >= 0.04 && cvd2 >= 0.06;
    const book = imbalance >= 0.03;
    const resumption = r1 >= 0;
    if (persistent && notOverextended && flow && book && resumption) {
      side = "BUY";
      score = 70
        + clamp((r15 - 0.002) / 0.006 * 8, 0, 8)
        + clamp((cvd2 - 0.06) / 0.30 * 10, 0, 10)
        + clamp((imbalance - 0.03) / 0.30 * 7, 0, 7)
        + clamp(finite(context.regimeConfidence, 0.5) * 5, 0, 5);
      reasons.push("trendPersistent","flowAligned","bidSupport","shortTermResumption");
    }
  }

  if (regime === "TREND_DOWN") {
    const persistent = r15 <= -0.002 && r5 <= -0.0007;
    const notOverextended = r5 >= -0.0045;
    const flow = cvd10 <= -0.04 && cvd2 <= -0.06;
    const book = imbalance <= -0.03;
    const resumption = r1 <= 0;
    if (persistent && notOverextended && flow && book && resumption) {
      side = "SELL";
      score = 70
        + clamp((Math.abs(r15) - 0.002) / 0.006 * 8, 0, 8)
        + clamp((Math.abs(cvd2) - 0.06) / 0.30 * 10, 0, 10)
        + clamp((Math.abs(imbalance) - 0.03) / 0.30 * 7, 0, 7)
        + clamp(finite(context.regimeConfidence, 0.5) * 5, 0, 5);
      reasons.push("trendPersistent","flowAligned","askPressure","shortTermResumption");
    }
  }

  if (!side) blocked.push("noConfirmedContinuation");
  if (blocked.length) side = null;

  return {
    family: "TREND_CONTINUATION_V1",
    horizon: "15_TO_90_MIN",
    action: side || "NO_TRADE",
    score: side ? Math.round(clamp(score, 0, 100)) : 0,
    reasons,
    blocked,
    researchOnly: true
  };
}
