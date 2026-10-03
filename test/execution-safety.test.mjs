import test from "node:test";
import assert from "node:assert/strict";
import { loadExecutionConfig, safeExecutionSummary } from "../execution/config.mjs";
import { evaluateTradeIntent } from "../execution/risk-engine.mjs";
import { transitionOrder, terminalOrderState } from "../execution/order-state.mjs";

function goodConfig(mode = "paper") {
  return loadExecutionConfig({
    EXECUTION_MODE: mode,
    EXECUTION_EXCHANGE: "BINANCE",
    LIVE_TRADING_ENABLED: mode === "live" ? "true" : "false",
    LIVE_TRADING_ACK: mode === "live" ? "REAL_ORDERS_CAN_LOSE_MONEY" : "",
    BINANCE_API_KEY: mode === "live" ? "test-key" : "",
    BINANCE_API_SECRET: mode === "live" ? "test-secret" : "",
    MAX_POSITION_NOTIONAL_USD: "5000",
    MAX_EFFECTIVE_LEVERAGE: "3",
    MIN_EXPECTED_NET_USD: "6.5"
  });
}

function goodIntent() {
  return {
    requestedNotionalUsd: 3000,
    effectiveLeverage: 2,
    expectedNetUsd: 8,
    maxLossAtStopUsd: 10,
    rewardRisk: 1.5
  };
}

function goodAccount() {
  return {
    equityUsd: 5_000,
    peakEquityUsd: 5_000,
    freeMarginUsd: 5_000,
    dailyPnlUsd: 0,
    openPositions: 0,
    killSwitch: false,
    exchangeHealthy: true
  };
}

function goodMarket() {
  return { bookFresh: true, marketDataAgeMs: 250, spreadBps: 1.2 };
}

test("execution defaults to disabled and never leaks credentials in summary", () => {
  const config = loadExecutionConfig({ BINANCE_API_KEY: "super-secret", BINANCE_API_SECRET: "secret-2" });
  assert.equal(config.mode, "disabled");
  const summary = JSON.stringify(safeExecutionSummary(config));
  assert.equal(summary.includes("super-secret"), false);
  assert.equal(summary.includes("secret-2"), false);
});

test("live mode fails closed without explicit gates and credentials", () => {
  const config = loadExecutionConfig({ EXECUTION_MODE: "live", EXECUTION_EXCHANGE: "BINANCE" });
  assert.equal(config.validation.ready, false);
  assert.ok(config.validation.failed.includes("liveTradingEnabled"));
  assert.ok(config.validation.failed.includes("liveTradingAcknowledged"));
  assert.ok(config.validation.failed.includes("credential:BINANCE_API_KEY"));
  assert.ok(config.validation.failed.includes("credential:BINANCE_API_SECRET"));
});

test("healthy paper trade intent passes every risk gate", () => {
  const result = evaluateTradeIntent(goodIntent(), goodAccount(), goodMarket(), goodConfig("paper"));
  assert.equal(result.allowed, true);
  assert.deepEqual(result.failed, []);
});

test("kill switch, stale data and weak expectancy independently block trading", () => {
  const config = goodConfig("paper");
  const killed = evaluateTradeIntent(goodIntent(), { ...goodAccount(), killSwitch: true }, goodMarket(), config);
  assert.ok(killed.failed.includes("killSwitch"));

  const stale = evaluateTradeIntent(goodIntent(), goodAccount(), { ...goodMarket(), marketDataAgeMs: 10_000 }, config);
  assert.ok(stale.failed.includes("marketDataTooOld"));

  const weak = evaluateTradeIntent({ ...goodIntent(), expectedNetUsd: 5 }, goodAccount(), goodMarket(), config);
  assert.ok(weak.failed.includes("expectedNetTooLow"));
});

test("risk engine blocks excessive stop loss, leverage, daily loss and drawdown", () => {
  const config = goodConfig("paper");
  const intent = { ...goodIntent(), effectiveLeverage: 5, maxLossAtStopUsd: 500 };
  const account = { ...goodAccount(), equityUsd: 47_000, peakEquityUsd: 50_000, dailyPnlUsd: -1000 };
  const result = evaluateTradeIntent(intent, account, goodMarket(), config);
  assert.ok(result.failed.includes("leverageLimit"));
  assert.ok(result.failed.includes("singleTradeRiskLimit"));
  assert.ok(result.failed.includes("dailyLossLimit"));
  assert.ok(result.failed.includes("drawdownLimit"));
});

test("order state machine rejects unsafe jumps", () => {
  const base = { state: "INTENT", history: [] };
  const approved = transitionOrder(base, "APPROVED", { riskDecision: "pass" });
  const submitted = transitionOrder(approved, "SUBMITTED");
  assert.equal(submitted.state, "SUBMITTED");
  assert.throws(() => transitionOrder(submitted, "CLOSED"), /Illegal order transition/);
  assert.equal(terminalOrderState("CLOSED"), true);
  assert.equal(terminalOrderState("FILLED"), false);
});


test("expected net floor scales with account equity", () => {
  const config = loadExecutionConfig({
    EXECUTION_MODE: "paper",
    EXECUTION_EXCHANGE: "BINANCE",
    MIN_EXPECTED_NET_USD: "6.5",
    MIN_EXPECTED_NET_EQUITY_PCT: "0.001",
    MAX_POSITION_NOTIONAL_USD: "50000",
    MAX_EFFECTIVE_LEVERAGE: "3"
  });
  const account = {
    ...goodAccount(),
    equityUsd: 50_000,
    peakEquityUsd: 50_000,
    freeMarginUsd: 50_000
  };
  const weak = evaluateTradeIntent({ ...goodIntent(), requestedNotionalUsd: 3000, expectedNetUsd: 20 }, account, goodMarket(), config);
  assert.equal(weak.allowed, false);
  assert.equal(weak.metrics.expectedNetFloorUsd, 50);
  const strong = evaluateTradeIntent({ ...goodIntent(), requestedNotionalUsd: 3000, expectedNetUsd: 55 }, account, goodMarket(), config);
  assert.equal(strong.failed.includes("expectedNetTooLow"), false);
});
