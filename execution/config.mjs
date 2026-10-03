const LIVE_ACK = "REAL_ORDERS_CAN_LOSE_MONEY";
const EXCHANGES = new Set(["BINANCE", "BYBIT", "OKX"]);
const MODES = new Set(["disabled", "paper", "live"]);

function bool(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function finitePositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadExecutionConfig(env = process.env) {
  const mode = String(env.EXECUTION_MODE || "disabled").trim().toLowerCase();
  const exchange = String(env.EXECUTION_EXCHANGE || "BINANCE").trim().toUpperCase();
  const phase = String(env.LIVE_TRADING_PHASE || "validation").trim().toLowerCase();

  const config = {
    mode,
    exchange,
    phase,
    liveTradingEnabled: bool(env.LIVE_TRADING_ENABLED),
    liveTradingAcknowledged: env.LIVE_TRADING_ACK === LIVE_ACK,
    strategyValidated: bool(env.LIVE_STRATEGY_VALIDATED),
    maxNotionalUsd: finitePositive(env.MAX_POSITION_NOTIONAL_USD, 5_000),
    maxLeverage: finitePositive(env.MAX_EFFECTIVE_LEVERAGE, 3),
    minExpectedNetUsd: finitePositive(env.MIN_EXPECTED_NET_USD, 6.5),
    maxSingleTradeRiskPct: finitePositive(env.MAX_SINGLE_TRADE_RISK_PCT, 0.0025),
    maxDailyLossPct: finitePositive(env.MAX_DAILY_LOSS_PCT, 0.015),
    maxDrawdownPct: finitePositive(env.MAX_DRAWDOWN_PCT, 0.05),
    maxOpenPositions: Math.max(1, Math.floor(finitePositive(env.MAX_OPEN_POSITIONS, 3))),
    maxSpreadBps: finitePositive(env.MAX_SPREAD_BPS, 6),
    maxMarketDataAgeMs: finitePositive(env.MAX_MARKET_DATA_AGE_MS, 3_000)
  };

  const validation = validateExecutionConfig(config, env);
  return { ...config, validation };
}

export function validateExecutionConfig(config, env = process.env) {
  const failed = [];
  if (!MODES.has(config.mode)) failed.push("executionModeKnown");
  if (!EXCHANGES.has(config.exchange)) failed.push("exchangeSupported");

  if (config.mode === "live") {
    if (!config.liveTradingEnabled) failed.push("liveTradingEnabled");
    if (!config.liveTradingAcknowledged) failed.push("liveTradingAcknowledged");
    if (config.phase === "production" && !config.strategyValidated) failed.push("strategyValidated");

    const credentialNames = requiredCredentialNames(config.exchange);
    for (const name of credentialNames) {
      if (!String(env[name] || "").trim()) failed.push(`credential:${name}`);
    }
  }

  return { ready: failed.length === 0, failed };
}

export function requiredCredentialNames(exchange) {
  switch (String(exchange || "").toUpperCase()) {
    case "BINANCE": return ["BINANCE_API_KEY", "BINANCE_API_SECRET"];
    case "BYBIT": return ["BYBIT_API_KEY", "BYBIT_API_SECRET"];
    case "OKX": return ["OKX_API_KEY", "OKX_API_SECRET", "OKX_API_PASSPHRASE"];
    default: return [];
  }
}

export function safeExecutionSummary(config) {
  return {
    mode: config.mode,
    exchange: config.exchange,
    phase: config.phase,
    liveTradingEnabled: config.liveTradingEnabled,
    liveTradingAcknowledged: config.liveTradingAcknowledged,
    strategyValidated: config.strategyValidated,
    limits: {
      maxNotionalUsd: config.maxNotionalUsd,
      maxLeverage: config.maxLeverage,
      minExpectedNetUsd: config.minExpectedNetUsd,
      maxSingleTradeRiskPct: config.maxSingleTradeRiskPct,
      maxDailyLossPct: config.maxDailyLossPct,
      maxDrawdownPct: config.maxDrawdownPct,
      maxOpenPositions: config.maxOpenPositions,
      maxSpreadBps: config.maxSpreadBps,
      maxMarketDataAgeMs: config.maxMarketDataAgeMs
    },
    ready: config.validation?.ready === true,
    failed: config.validation?.failed || []
  };
}

export const LIVE_TRADING_ACK_VALUE = LIVE_ACK;
