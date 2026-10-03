import test from "node:test";
import assert from "node:assert/strict";
import { loadExecutionConfig } from "../execution/config.mjs";
import { createShadowBroker } from "../execution/shadow-broker.mjs";
import { evaluateVenueAlignment, makeClientOrderId } from "../execution/venue-policy.mjs";

const config = loadExecutionConfig({
  EXECUTION_MODE: "paper",
  EXECUTION_EXCHANGE: "BINANCE",
  MAX_POSITION_NOTIONAL_USD: "5000",
  MAX_EFFECTIVE_LEVERAGE: "3",
  MIN_EXPECTED_NET_USD: "6.5"
});

const intent = {
  symbol: "BTCUSDT",
  side: "BUY",
  requestedNotionalUsd: 3000,
  effectiveLeverage: 2,
  expectedNetUsd: 8,
  maxLossAtStopUsd: 80,
  rewardRisk: 1.5
};

const account = {
  equityUsd: 50_000,
  peakEquityUsd: 50_000,
  freeMarginUsd: 20_000,
  dailyPnlUsd: 0,
  openPositions: 0,
  killSwitch: false,
  exchangeHealthy: true
};

const binanceMarket = {
  exchange: "BINANCE",
  bookExchange: "BINANCE",
  bookFresh: true,
  marketDataAgeMs: 250,
  spreadBps: 1
};

test("venue policy rejects using a different exchange book for execution", () => {
  const result = evaluateVenueAlignment({
    executionExchange: "BINANCE",
    marketExchange: "BYBIT",
    bookExchange: "BYBIT"
  });
  assert.equal(result.allowed, false);
  assert.ok(result.failed.includes("marketVenueMismatch"));
  assert.ok(result.failed.includes("bookVenueMismatch"));
});

test("shadow broker approves a valid intent but never submits it", async () => {
  const decisions = [];
  const broker = createShadowBroker({ config, onDecision: d => decisions.push(d) });
  const result = await broker.submit({ intent, account, market: binanceMarket });
  assert.equal(result.accepted, true);
  assert.equal(result.shadowOnly, true);
  assert.equal(result.order.state, "APPROVED");
  assert.equal(decisions.length, 1);
});

test("shadow broker rejects otherwise-good trade when venue data mismatches", async () => {
  const broker = createShadowBroker({ config });
  const result = await broker.submit({
    intent,
    account,
    market: { ...binanceMarket, exchange: "BYBIT", bookExchange: "BYBIT" }
  });
  assert.equal(result.accepted, false);
  assert.equal(result.order.state, "REJECTED");
  assert.ok(result.failed.includes("marketVenueMismatch"));
});

test("client order ids are bounded and safe", () => {
  const id = makeClientOrderId("crypto engine!", 1234567890, 42);
  assert.ok(id.length <= 32);
  assert.match(id, /^[A-Za-z0-9_-]+$/);
});
