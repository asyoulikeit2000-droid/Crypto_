function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function minimumExpectedNetUsd(config, equityUsd) {
  const absoluteFloor = finite(config?.minExpectedNetUsd, Infinity);
  const equityFloor = finite(equityUsd) * finite(config?.minExpectedNetEquityPct, 0);
  return Math.max(absoluteFloor, equityFloor);
}

export function evaluateTradeIntent(intent, account, market, config) {
  const failed = [];
  const equityUsd = finite(account?.equityUsd);
  const peakEquityUsd = Math.max(equityUsd, finite(account?.peakEquityUsd, equityUsd));
  const dailyPnlUsd = finite(account?.dailyPnlUsd);
  const openPositions = Math.max(0, Math.floor(finite(account?.openPositions)));
  const freeMarginUsd = finite(account?.freeMarginUsd);

  const requestedNotionalUsd = finite(intent?.requestedNotionalUsd);
  const leverage = finite(intent?.effectiveLeverage);
  const expectedNetUsd = finite(intent?.expectedNetUsd, -Infinity);
  const maxLossAtStopUsd = Math.max(0, finite(intent?.maxLossAtStopUsd));
  const rewardRisk = finite(intent?.rewardRisk);

  const spreadBps = finite(market?.spreadBps, Infinity);
  const marketDataAgeMs = finite(market?.marketDataAgeMs, Infinity);

  if (config?.mode === "disabled") failed.push("executionDisabled");
  if (config?.mode === "live" && config?.validation?.ready !== true) failed.push("liveConfigNotReady");
  if (account?.killSwitch === true) failed.push("killSwitch");
  if (account?.exchangeHealthy !== true) failed.push("exchangeUnhealthy");
  if (market?.bookFresh !== true) failed.push("orderbookStale");
  if (marketDataAgeMs > finite(config?.maxMarketDataAgeMs, 3000)) failed.push("marketDataTooOld");
  if (spreadBps > finite(config?.maxSpreadBps, 6)) failed.push("spreadTooWide");

  if (!(equityUsd > 0)) failed.push("equityUnavailable");
  if (!(freeMarginUsd > 0)) failed.push("freeMarginUnavailable");
  if (!(requestedNotionalUsd > 0)) failed.push("invalidNotional");
  if (requestedNotionalUsd > finite(config?.maxNotionalUsd, 0)) failed.push("notionalLimit");
  if (!(leverage > 0) || leverage > finite(config?.maxLeverage, 1)) failed.push("leverageLimit");
  if (openPositions >= Math.max(1, Math.floor(finite(config?.maxOpenPositions, 1)))) failed.push("openPositionLimit");

  const expectedNetFloorUsd = minimumExpectedNetUsd(config, equityUsd);
  if (expectedNetUsd < expectedNetFloorUsd) failed.push("expectedNetTooLow");
  if (rewardRisk < 1.25) failed.push("rewardRiskTooLow");

  const tradeRiskLimitUsd = equityUsd * finite(config?.maxSingleTradeRiskPct, 0);
  if (!(maxLossAtStopUsd > 0) || maxLossAtStopUsd > tradeRiskLimitUsd) failed.push("singleTradeRiskLimit");

  const dailyLossLimitUsd = equityUsd * finite(config?.maxDailyLossPct, 0);
  if (dailyPnlUsd <= -dailyLossLimitUsd) failed.push("dailyLossLimit");

  const drawdownPct = peakEquityUsd > 0 ? (peakEquityUsd - equityUsd) / peakEquityUsd : 1;
  if (drawdownPct >= finite(config?.maxDrawdownPct, 0)) failed.push("drawdownLimit");

  const marginNeededUsd = leverage > 0 ? requestedNotionalUsd / leverage : Infinity;
  if (marginNeededUsd > freeMarginUsd * 0.5) failed.push("marginConcentration");

  return {
    allowed: failed.length === 0,
    failed,
    metrics: {
      equityUsd,
      expectedNetUsd,
      expectedNetFloorUsd,
      maxLossAtStopUsd,
      tradeRiskLimitUsd,
      dailyLossLimitUsd,
      drawdownPct,
      marginNeededUsd,
      spreadBps,
      marketDataAgeMs
    }
  };
}
