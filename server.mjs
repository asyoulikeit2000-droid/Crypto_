import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SECRET_KEY || "";
const SCHEMA = process.env.SUPABASE_DB_SCHEMA || "engine";
const RELAY_URL = process.env.MARKET_RELAY_URL || (SB ? SB + "/functions/v1/market-data-relay" : "");
const RELAY_KEY = process.env.MARKET_RELAY_KEY || "";

const state = {
  startedAt: new Date().toISOString(),
  bootStage: "starting",
  ready: false,
  lastTrade: null,
  lastBook: null,
  lastDeriv: null,
  assets: [],
  errors: [],
  counts: { trades: 0, books: 0, derivatives: 0 }
};

function log(message, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...meta }));
}
function recordError(e) {
  const message = String(e?.message || e);
  state.errors.push(message);
  state.errors = state.errors.slice(-10);
  console.error(JSON.stringify({ ts: new Date().toISOString(), error: message }));
}

async function sb(table, method = "GET", params = {}, body, extraHeaders = {}) {
  if (!SB || !KEY) throw new Error("Supabase credentials not configured");
  const u = new URL(SB + "/rest/v1/" + table);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const h = { apikey: KEY, "Accept-Profile": SCHEMA };
  if (method !== "GET") {
    h["Content-Type"] = "application/json";
    h["Content-Profile"] = SCHEMA;
    h.Prefer = extraHeaders.Prefer || "return=minimal";
  }
  const r = await fetch(u, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error("Supabase " + r.status + " " + await r.text());
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}

async function relayJson(mode, symbols = []) {
  if (!RELAY_URL || !RELAY_KEY) throw new Error("Market relay is not configured");
  const u = new URL(RELAY_URL);
  u.searchParams.set("mode", mode);
  if (symbols.length) u.searchParams.set("symbols", symbols.join(","));
  const r = await fetch(u, {
    headers: {
      apikey: RELAY_KEY,
      Authorization: "Bearer " + RELAY_KEY,
      "x-region": "ap-southeast-1"
    }
  });
  const text = await r.text();
  if (!r.ok) throw new Error("Market relay HTTP " + r.status + " " + text.slice(0, 500));
  return JSON.parse(text);
}

async function writeStatus(status, message = null, provider = "BYBIT_RELAY") {
  const payload = {
    checked_at: new Date().toISOString(),
    status,
    last_event_at: new Date().toISOString(),
    error_message: message,
    metadata: {}
  };
  try {
    const updated = await sb("provider_status", "PATCH", {
      provider: "eq." + provider,
      dataset: "eq.engine"
    }, payload, { Prefer: "return=minimal" });
    return updated;
  } catch (e) {
    recordError(e);
    try {
      await sb("provider_status", "POST", {
        on_conflict: "provider,dataset"
      }, {
        provider,
        dataset: "engine",
        ...payload
      }, {
        Prefer: "resolution=merge-duplicates,return=minimal"
      });
    } catch (e2) {
      recordError(e2);
    }
  }
}
async function refreshUniverse() {
  log("universe_refresh_start");
  const fetchJson = async (url, label) => {
    try {
      const r = await fetch(url, { headers: { "user-agent": "crypto-intelligence-engine/0.1" } });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(label + " HTTP " + r.status + " " + body.slice(0, 300));
      }
      return await r.json();
    } catch (e) {
      recordError(e);
      return null;
    }
  };
  const coins = await fetchJson("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false", "CoinGecko");
  if (!coins) {
    const fallback = await sb("assets", "GET", {
      select: "asset_id,symbol,metadata",
      active: "eq.true",
      limit: "50"
    });
    if (fallback.length) {
      state.assets = fallback.slice(0, 30).map((x, i) => ({
        id: x.asset_id,
        symbol: x.symbol.toUpperCase(),
        rank: Number(x.metadata?.rank || i + 1)
      }));
      log("universe_refresh_fallback", { assets: state.assets.length, source: "supabase" });
      return;
    }

    // Bootstrap through the Supabase Edge relay. Railway's SFO egress is
    // blocked by Bybit/CloudFront, while the relay can execute in Singapore.
    const relay = await relayJson("bootstrap");
    const infoJson = { result: { list: relay.info || [] } };
    const tickerJson = { result: { list: relay.tickers || [] } };
    if (!infoJson.result.list.length || !tickerJson.result.list.length) throw new Error("Market relay universe unavailable");
    const allowed = new Set(
      infoJson.result.list
        .filter(x => x.status === "Trading" && x.quoteCoin === "USDT" && x.contractType === "LinearPerpetual")
        .map(x => x.symbol)
    );
    const liquid = tickerJson.result.list
      .filter(x => allowed.has(x.symbol))
      .sort((a, b) => Number(b.turnover24h || 0) - Number(a.turnover24h || 0))
      .slice(0, 30);

    const assets = [];
    for (const x of liquid) {
      const base = x.symbol.replace(/USDT$/, "");
      const assetId = "bybit:" + base.toLowerCase();
      try {
        await sb("assets", "POST", { on_conflict: "asset_id" }, {
          asset_id: assetId,
          symbol: base,
          name: base,
          base_asset: base,
          quote_asset: "USDT",
          asset_type: "perpetual",
          active: true,
          last_seen_at: new Date().toISOString(),
          metadata: { universe_source: "bybit_liquidity_bootstrap", turnover_24h: Number(x.turnover24h || 0) }
        });
      } catch (e) { recordError(e); }
      assets.push({ id: assetId, symbol: base, rank: null, universeSource: "bybit_liquidity_bootstrap" });
    }
    state.assets = assets;
    log("universe_refresh_bootstrap", { assets: state.assets.length, source: "bybit_liquidity_bootstrap" });
    return;
  }
  const marketCoins = coins
    .filter(x => !x.symbol?.includes("usd") && !x.name?.toLowerCase().includes("wrapped"))
    .slice(0, 30);

  for (const x of coins) {
    try {
      await sb("assets", "POST", { on_conflict: "asset_id" }, {
        asset_id: x.id,
        symbol: x.symbol.toUpperCase(),
        name: x.name,
        base_asset: x.symbol.toUpperCase(),
        quote_asset: "USD",
        asset_type: "spot",
        active: true,
        last_seen_at: new Date().toISOString(),
        metadata: { rank: x.market_cap_rank, market_cap_usd: x.market_cap, current_price: x.current_price }
      });
    } catch (e) { recordError(e); }
  }
  state.assets = marketCoins.map(x => ({ id: x.id, symbol: x.symbol.toUpperCase(), rank: x.market_cap_rank }));
  log("universe_refresh_complete", { assets: state.assets.length });
}

let pollTimer = null;
const seenTradeIds = new Set();

async function pollMarketData() {
  const symbols = state.assets.map(x => x.symbol.toUpperCase() + "USDT").slice(0, 30);
  if (!symbols.length) return;
  const relay = await relayJson("snapshot_trades", symbols);
  const receivedAt = new Date().toISOString();

  for (const t of relay.trades || []) {
    const asset = state.assets.find(x => x.symbol.toUpperCase() + "USDT" === String(t.symbol).toUpperCase());
    if (!asset) continue;
    const tradeId = String(t.i || t.execId || ((t.T || t.time || receivedAt) + ":" + (t.p || t.price) + ":" + (t.v || t.size) + ":" + (t.S || t.side)));
    if (seenTradeIds.has(asset.id + ":" + tradeId)) continue;
    seenTradeIds.add(asset.id + ":" + tradeId);
    if (seenTradeIds.size > 10000) {
      const first = seenTradeIds.values().next().value;
      seenTradeIds.delete(first);
    }
    state.lastTrade = receivedAt;
    state.counts.trades++;
    await sb("trades", "POST", {}, {
      asset_id: asset.id, exchange: "BYBIT", trade_id: tradeId,
      observed_at: new Date(Number(t.T || t.time)).toISOString(), price: Number(t.p || t.price),
      quantity: Number(t.v || t.size), side: (t.S || t.side) === "Buy" ? "BUY" : "SELL",
      is_buyer_maker: (t.S || t.side) !== "Buy", status: "LIVE",
      metadata: { symbol: t.symbol, received_at: receivedAt, source: "bybit_recent_trade_via_supabase_edge" }
    });
  }

  for (const book of relay.books || []) {
    const asset = state.assets.find(x => x.symbol.toUpperCase() + "USDT" === String(book.symbol).toUpperCase());
    if (!asset || book.error) continue;
    const bid = book.b?.[0], ask = book.a?.[0];
    if (!bid || !ask) continue;
    const bp = Number(bid[0]), bq = Number(bid[1]);
    const ap = Number(ask[0]), aq = Number(ask[1]);
    const mid = (bp + ap) / 2;
    const imbalance = (bq - aq) / (bq + aq || 1);
    const spreadBps = ((ap - bp) / mid) * 10000;
    state.lastBook = receivedAt;
    state.counts.books++;
    await sb("orderbook_snapshots", "POST", {}, {
      asset_id: asset.id, exchange: "BYBIT", observed_at: receivedAt,
      best_bid: bp, best_ask: ap, spread_bps: spreadBps,
      bid_depth: bp * bq, ask_depth: ap * aq, imbalance,
      depth_levels: 1, status: "LIVE",
      metadata: { symbol: book.symbol, received_at: receivedAt, source: "bybit_orderbook_via_supabase_edge" }
    });
  }

  for (const x of relay.tickers || []) {
    const asset = state.assets.find(a => a.symbol.toUpperCase() + "USDT" === String(x.symbol).toUpperCase());
    if (!asset) continue;
    const now = new Date().toISOString();
    if (x.fundingRate !== undefined) {
      await sb("funding", "POST", {}, {
        asset_id: asset.id, exchange: "BYBIT", observed_at: now,
        funding_rate: Number(x.fundingRate),
        next_funding_at: x.nextFundingTime ? new Date(Number(x.nextFundingTime)).toISOString() : null,
        mark_price: Number(x.markPrice), index_price: Number(x.indexPrice), status: "LIVE"
      });
      state.lastDeriv = now;
      state.counts.derivatives++;
    }
  }
}

function connect() {
  if (pollTimer) return;
  log("bybit_relay_polling_start");
  pollMarketData().catch(e => { recordError(e); writeStatus("DELAYED", e.message); });
  pollTimer = setInterval(() => {
    pollMarketData().catch(e => { recordError(e); writeStatus("DELAYED", e.message); });
  }, 5000);
}

async function safeRead(table, params = {}) {
  try { return await sb(table, "GET", params); }
  catch (e) { recordError(e); return []; }
}

async function dashboardData() {
  const [signals, paperTrades, providers] = await Promise.all([
    safeRead("latest_signals", { select: "*", limit: "50" }),
    safeRead("latest_paper_trades", { select: "*", limit: "50" }),
    safeRead("provider_status", { select: "*", limit: "20" })
  ]);
  return {
    generatedAt: new Date().toISOString(),
    health: {
      ok: state.ready, mode: "live", bootStage: state.bootStage,
      startedAt: state.startedAt, assets: state.assets.length,
      lastTrade: state.lastTrade, lastBook: state.lastBook, lastDeriv: state.lastDeriv,
      counts: state.counts, errors: state.errors.slice(-5)
    },
    assets: state.assets, signals, paperTrades, providers
  };
}

function sendJson(res, value, status = 200) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(value));
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, { error: "not_found" }, 404);
  try {
    const data = await readFile(file);
    const ext = extname(file);
    const type = ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".js" ? "text/javascript; charset=utf-8"
      : ext === ".css" ? "text/css; charset=utf-8"
      : "application/octet-stream";
    res.statusCode = 200;
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "no-cache");
    res.setHeader("x-content-type-options", "nosniff");
    res.end(data);
  } catch { sendJson(res, { error: "not_found" }, 404); }
}

async function refreshDerivatives() {
  try {
    await pollMarketData();
  } catch (e) { recordError(e); }
}
async function main() {
  try {
    state.bootStage = "supabase";
    log("boot_supabase");
    await writeStatus("CONNECTING", "boot");

    state.bootStage = "universe";
    await refreshUniverse();

    state.bootStage = "market_relay";
    connect();

    state.bootStage = "derivatives";
    await refreshDerivatives();

    setInterval(() => refreshUniverse().catch(e => { recordError(e); writeStatus("DELAYED", e.message); }), 10 * 60 * 1000);
    setInterval(() => refreshDerivatives().catch(recordError), 60 * 1000);
    setInterval(() => {
      const fresh = state.lastTrade && Date.now() - Date.parse(state.lastTrade) < 20000;
      writeStatus(fresh ? "LIVE" : "STALE", "heartbeat");
    }, 15000);

    state.bootStage = "ready";
    state.ready = true;
    log("engine_ready", { assets: state.assets.length });
    await writeStatus("LIVE", "engine ready");
  } catch (e) {
    state.bootStage = "degraded";
    state.ready = true;
    recordError(e);
    await writeStatus("UNAVAILABLE", String(e?.message || e));
    log("engine_boot_degraded");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/api/health") {
      return sendJson(res, {
        ok: true, ready: state.ready, mode: "live", bootStage: state.bootStage,
        startedAt: state.startedAt, assets: state.assets.length,
        lastTrade: state.lastTrade, lastBook: state.lastBook, lastDeriv: state.lastDeriv,
        counts: state.counts, errors: state.errors.slice(-5)
      }, state.ready ? 200 : 503);
    }
    if (path === "/api/market") return sendJson(res, {
      assets: state.assets, counts: state.counts,
      lastTrade: state.lastTrade, lastBook: state.lastBook, lastDeriv: state.lastDeriv
    });
    if (path === "/api/dashboard") return sendJson(res, await dashboardData());
    if (path === "/api/signals") return sendJson(res, await safeRead("latest_signals", { select: "*", limit: "100" }));
    if (path === "/api/paper") return sendJson(res, await safeRead("latest_paper_trades", { select: "*", limit: "100" }));
    if (path === "/api/providers") return sendJson(res, await safeRead("provider_status", { select: "*", limit: "50" }));
    if (path.startsWith("/api/")) return sendJson(res, { error: "not_found" }, 404);
    return serveStatic(req, res);
  } catch (e) {
    recordError(e);
    return sendJson(res, { error: "server_error", message: String(e?.message || e) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  log("http_server_listening", { host: HOST, port: PORT });
  main();
});

process.on("SIGTERM", () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try { ws?.close(); } catch {}
  server.close(() => process.exit(0));
});
// Market-data access fix: Bybit relay through Supabase Edge Singapore.
