export function evaluateSignalReadiness(calibration = {}, validation = {}) {
  const test = validation?.test || {};
  const checks = {
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
