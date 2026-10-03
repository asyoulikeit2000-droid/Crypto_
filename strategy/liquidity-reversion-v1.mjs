function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function normRegime(value) {
  return String(value || "UNKNOWN").trim().toUpperCase();
}

export function evaluateLiquidityReversion(features = {}, context = {}) {
  const reasons = [];
  const blocked = [];

  const regime = normRegime(context.regime);
  const r1 = finite(features.return_1m);
  const r5 = finite(features.return_5m);
  const r15 = finite(features.return_15m);
  const cvd2 = finite(features.cvd_2m);
  const cvd10 = finite(features.cvd_10m);
  const imbalance = finite(features.orderbook_imbalance);
  const spread = finite(features.spread_bps, Infinity);
  const quality = features.microstructure_quality === true && features.data_fresh === true;

  if (!quality) blocked.push("marketQuality");
  if (spread > finite(context.maxSpreadBps, 4)) blocked.push("spread");
  if (["HIGH_VOL", "CRASH", "PANIC"].includes(regime)) blocked.push("abnormalRegime");

  const strongDownTrend = ["TREND_DOWN", "BEAR_TREND", "STRONG_DOWN"].includes(regime);
  const strongUpTrend = ["TREND_UP", "BULL_TREND", "STRONG_UP"].includes(regime);

  let side = null;
  let score = 0;

  const longImpulse = r5 <= -0.0015 && r15 <= -0.0020;
  const longFlowTurn = cvd2 >= 0.05 && cvd2 - cvd10 >= 0.10;
  const longBook = imbalance >= 0.05;
  const longStabilize = r1 >= -0.00015;

  if (!strongDownTrend && longImpulse && longFlowTurn && longBook && longStabilize) {
    side = "BUY";
    score = 70;
    score += clamp((Math.abs(r5) - 0.0015) / 0.0025 * 10, 0, 10);
    score += clamp((cvd2 - cvd10 - 0.10) / 0.30 * 10, 0, 10);
    score += clamp((imbalance - 0.05) / 0.30 * 10, 0, 10);
    reasons.push("downsideLiquiditySweep", "aggressiveFlowTurnedUp", "bidBookRecovered", "oneMinuteStabilized");
  }

  const shortImpulse = r5 >= 0.0015 && r15 >= 0.0020;
  const shortFlowTurn = cvd2 <= -0.05 && cvd10 - cvd2 >= 0.10;
  const shortBook = imbalance <= -0.05;
  const shortStabilize = r1 <= 0.00015;

  if (!strongUpTrend && shortImpulse && shortFlowTurn && shortBook && shortStabilize) {
    side = "SELL";
    score = 70;
    score += clamp((Math.abs(r5) - 0.0015) / 0.0025 * 10, 0, 10);
    score += clamp((cvd10 - cvd2 - 0.10) / 0.30 * 10, 0, 10);
    score += clamp((Math.abs(imbalance) - 0.05) / 0.30 * 10, 0, 10);
    reasons.push("upsideLiquiditySweep", "aggressiveFlowTurnedDown", "askBookRecovered", "oneMinuteStabilized");
  }

  if (!side) blocked.push("noConfirmedReversal");
  if (blocked.length) side = null;

  return {
    family: "LIQUIDITY_REVERSION_V1",
    horizon: "15_TO_90_MIN",
    action: side || "NO_TRADE",
    score: side ? Math.round(clamp(score, 0, 100)) : 0,
    reasons,
    blocked,
    researchOnly: true
  };
}
