import test from "node:test";
import assert from "node:assert/strict";
import { normalizePair } from "../scanner/providers/dexscreener.mjs";

test("DexScreener pair age is robust when normalizer is used as Array.map callback", () => {
  const created = Date.now() - 60 * 60 * 1000;
  const pair = {
    chainId: "solana",
    pairAddress: "pair",
    pairCreatedAt: created,
    baseToken: { address: "token", name: "Token", symbol: "TOK" },
    quoteToken: { address: "quote", name: "Quote", symbol: "Q" },
    priceUsd: "1",
    liquidity: { usd: 100000 },
    txns: {},
    volume: {},
    priceChange: {}
  };
  const [row] = [pair].map(normalizePair);
  assert.ok(row.pairAgeHours >= 0.95 && row.pairAgeHours <= 1.1, "pair age should be about one hour");
});
