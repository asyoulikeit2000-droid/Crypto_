export function evaluateSignalReadiness(calibration = {}, validation = {}) {
  const test = validation?.test || {};
  const checks = {
    independentValidation: validation?.split?.method === "purged_expanding_window" && validation?.folds?.length >= 5,
    costCoverageComplete: validation?.costCoverageComplete === true,
    calibrationActive: calibration?.status === "ACTIVE",
    walkForwardComplete: validation?.status === "COMPLETE",
    testSampleSufficient: Number(test.n || 0) >= 20,
    averagePnlPositive: Number(test.avgPnl || 0) > 0,
    totalPnlPositive: Number(test.totalPnl || 0) > 0
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ready: failed.length === 0,
    checks,
    failed,
    metrics: {
      sampleSize: Number(test.n || 0),
      winRate: Number(test.winRate || 0),
      averagePnl: Number(test.avgPnl || 0),
      totalPnl: Number(test.totalPnl || 0),
      validatedAt: validation?.evaluatedAt || null
    }
  };
}

export function evaluateProductionRobustness(validation = {}) {
  const r = validation?.robustness || {};
  const positiveFolds = Number(r.positiveFolds || 0);
  const foldCount = Number(r.foldCount || 0);
  const medianAvgPnl = Number(r.medianAvgPnl || 0);
  const recentTotalPnl = Number(r.recentTotalPnl || 0);
  const checks = {
    enoughFolds: foldCount >= 5,
    majorityPositiveFolds: positiveFolds >= 3,
    medianFoldPositive: medianAvgPnl > 0,
    recentWindowPositive: recentTotalPnl > 0
  };
  const failed = Object.entries(checks).filter(([,ok])=>!ok).map(([k])=>k);
  return { ready: failed.length === 0, checks, failed, metrics: { positiveFolds, foldCount, medianAvgPnl, recentTotalPnl } };
}
