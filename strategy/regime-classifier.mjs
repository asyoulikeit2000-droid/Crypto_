function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function abs(v) { return Math.abs(finite(v)); }

export function classifyExecutionRegime(features = {}, btc = {}) {
  const r1 = finite(features.return_1m);
  const r5 = finite(features.return_5m);
  const r15 = finite(features.return_15m);
  const rv = Math.max(0, finite(features.realized_vol));
  const cvd2 = finite(features.cvd_2m);
  const cvd10 = finite(features.cvd_10m);
  const spread = finite(features.spread_bps, Infinity);
  const btc5Raw = Number(btc.return_5m);
  const btc15Raw = Number(btc.return_15m);
  const btcAvailable = Number.isFinite(btc5Raw) && Number.isFinite(btc15Raw);
  const btc5 = btcAvailable ? btc5Raw : 0;
  const btc15 = btcAvailable ? btc15Raw : 0;

  if (features.data_fresh !== true || features.microstructure_quality !== true || spread > 6) {
    return { regime: "UNTRADEABLE", confidence: 1, reasons: ["marketQuality"] };
  }

  const extremeMove = abs(r5) >= 0.006 || abs(r15) >= 0.012;
  const extremeVol = rv >= 0.008;
  if (extremeMove || extremeVol) {
    return {
      regime: "HIGH_VOL",
      confidence: Math.min(1, 0.7 + abs(r15) * 20 + rv * 10),
      reasons: [extremeMove ? "extremeMove" : null, extremeVol ? "extremeVol" : null].filter(Boolean)
    };
  }

  const up = r15 > 0.002 && r5 > 0.0007 && cvd10 > 0.03;
  const down = r15 < -0.002 && r5 < -0.0007 && cvd10 < -0.03;
  const btcConfirmsUp = btcAvailable && btc15 >= -0.001 && btc5 >= -0.001;
  const btcConfirmsDown = btcAvailable && btc15 <= 0.001 && btc5 <= 0.001;

  if (up && btcConfirmsUp) {
    return {
      regime: "TREND_UP",
      confidence: Math.min(1, 0.55 + abs(r15) * 40 + Math.max(0, cvd10) * 0.5),
      reasons: ["priceTrendUp", "flowAligned", "btcNotOpposing"]
    };
  }
  if (down && btcConfirmsDown) {
    return {
      regime: "TREND_DOWN",
      confidence: Math.min(1, 0.55 + abs(r15) * 40 + Math.max(0, -cvd10) * 0.5),
      reasons: ["priceTrendDown", "flowAligned", "btcNotOpposing"]
    };
  }

  const compressed = abs(r15) < 0.0015 && abs(r5) < 0.0008 && rv < 0.0035;
  if (compressed) {
    return { regime: "COMPRESSION", confidence: 0.7, reasons: ["lowDirectionalMove", "lowVolatility"] };
  }

  const flowConflict = Math.sign(r5) !== Math.sign(cvd10) && abs(r5) > 0.0008 && abs(cvd10) > 0.08;
  if (flowConflict || (abs(r15) < 0.003 && abs(cvd2) < 0.25)) {
    return {
      regime: "RANGE",
      confidence: flowConflict ? 0.8 : 0.6,
      reasons: flowConflict ? ["priceFlowConflict"] : ["limitedDirectionalPersistence"]
    };
  }

  return { regime: "MIXED", confidence: 0.5, reasons: ["noDominantRegime"] };
}
