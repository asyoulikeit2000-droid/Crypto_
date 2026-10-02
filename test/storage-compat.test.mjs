import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("Turso storage preserves engine and scanner semantics", async (t) => {
  process.env.TURSO_DATABASE_URL = pathToFileURL(join(tmpdir(), "crypto-storage-" + process.pid + "-" + Date.now() + ".db")).href;
  process.env.TURSO_AUTH_TOKEN = "";
  const mod = await import("../storage/turso-store.mjs?test=" + Date.now());
  const store = mod.createTursoCompat();
  t.after(() => store.client.close?.());

  await store.initialize();
  assert.equal(await store.healthcheck(), true);

  const first = await store.db("scanner_tokens", "POST", { on_conflict: "chain_id,contract_address" }, {
    chain_id: "solana", contract_address: "abc", token_symbol: "ABC"
  }, { Prefer: "resolution=ignore-duplicates,return=representation" });
  assert.equal(first.length, 1);
  assert.ok(first[0].token_id);

  const duplicate = await store.db("scanner_tokens", "POST", { on_conflict: "chain_id,contract_address" }, {
    chain_id: "solana", contract_address: "abc", token_symbol: "ABC2"
  }, { Prefer: "resolution=ignore-duplicates,return=representation" });
  assert.equal(duplicate.length, 0);

  const token = await store.db("scanner_tokens", "GET", {
    chain_id: "eq.solana", contract_address: "eq.abc", select: "token_id,token_symbol"
  });
  assert.equal(token.length, 1);
  assert.equal(token[0].token_symbol, "ABC");

  const signal = await store.db("signals", "POST", {}, {
    asset_id: "bybit:btc", created_at: new Date().toISOString(), signal: "LONG"
  }, { Prefer: "return=representation" });
  assert.ok(signal[0].signal_id);

  await store.db("provider_status", "POST", { on_conflict: "provider,dataset" }, {
    provider: "CLOUDFLARE_BYBIT", dataset: "market", status: "BOOTING"
  }, { Prefer: "resolution=merge-duplicates,return=minimal" });
  await store.db("provider_status", "POST", { on_conflict: "provider,dataset" }, {
    provider: "CLOUDFLARE_BYBIT", dataset: "market", status: "OK"
  }, { Prefer: "resolution=merge-duplicates,return=minimal" });
  const providers = await store.db("provider_status", "GET", { provider: "eq.CLOUDFLARE_BYBIT", dataset: "eq.market" });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].status, "OK");

  await store.db("signals", "PATCH", { signal_id: "eq." + signal[0].signal_id }, { risk_state: "SHADOW" });
  const patched = await store.db("signals", "GET", { signal_id: "eq." + signal[0].signal_id });
  assert.equal(patched[0].risk_state, "SHADOW");

  await store.db("scanner_tokens", "DELETE", { chain_id: "eq.solana", contract_address: "eq.abc" });
  assert.equal((await store.db("scanner_tokens", "GET", { chain_id: "eq.solana" })).length, 0);
});
