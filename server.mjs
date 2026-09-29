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

async function writeStatus(status, message = null) {
  const payload = {
    checked_at: new Date().toISOString(),
    status,
    last_event_at: new Date().toISOString(),
    error_message: message,
    metadata: {}
  };
  try {
    const existing = await sb("provider_status", "GET", {
      select: "provider",
      provider: "eq.BINANCE",
      dataset: "eq.engine",
      limit: "1"
    });
    await sb("provider_status", "POST", {
      on_conflict: "provider,dataset"
    }, {
      provider: "BINANCE",
      dataset: "engine",
      ...payload
    }, {
      Prefer: "resolution=merge,return=minimal"
    });
  } catch (e) {
    recordError(e);
  }
}
async function refreshUniverse() {
  log("universe_refresh_start");
  const r = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false");
  if (!r.ok) {
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

    // Bootstrap only: if CoinGecko is temporarily unavailable and Supabase has
    // no prior universe, use the most liquid USDT perpetuals so the live portal
    // can start collecting real data. This is explicitly marked degraded and
    // must not be treated as a market-cap-ranked Top-30 universe.
    const info = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
    const ticker = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
    if (!info.ok || !ticker.ok) throw new Error("Universe providers unavailable");
    const infoJson = await info.json();
    const tickerJson = await ticker.json();
    const allowed = new Set(
      infoJson.symbols
        .filter(x => x.status === "TRADING" && x.quoteAsset === "USDT" && x.contractType === "PERPETUAL")
        .map(x => x.symbol)
    );
    const liquid = tickerJson
      .filter(x => allowed.has(x.symbol))
      .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
      .slice(0, 30);

    const assets = [];
    for (const x of liquid) {
      const base = x.symbol.replace(/USDT$/, "");
      const assetId = "binance:" + base.toLowerCase();
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
          metadata: { universe_source: "binance_liquidity_bootstrap", quote_volume_24h: Number(x.quoteVolume) }
        });
      } catch (e) { recordError(e); }
      assets.push({ id: assetId, symbol: base, rank: null, universeSource: "binance_liquidity_bootstrap" });
    }
    state.assets = assets;
    log("universe_refresh_bootstrap", { assets: state.assets.length, source: "binance_liquidity_bootstrap" });
    return;
  }
  const coins = (await r.json())
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
  state.assets = coins.map(x => ({ id: x.id, symbol: x.symbol.toUpperCase(), rank: x.market_cap_rank }));
  log("universe_refresh_complete", { assets: state.assets.length });
}

let ws = null;
let reconnectTimer = null;

function connect() {
  if (typeof WebSocket !== "function") throw new Error("WebSocket global is unavailable in this Node runtime");
  if (ws) { try { ws.close(); } catch {} ws = null; }

  const symbols = state.assets.map(x => x.symbol.toLowerCase() + "usdt").slice(0, 30);
  const streams = symbols.flatMap(s => [s + "@trade", s + "@depth20@100ms"]);
  const url = "wss://fstream.binance.com/stream?streams=" + streams.join("/");
  log("binance_ws_connecting", { symbols: symbols.length });
  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    log("binance_ws_open", { symbols: symbols.length });
    writeStatus("LIVE", "streams connected");
  });
  ws.addEventListener("close", () => {
    log("binance_ws_closed");
    writeStatus("STALE", "websocket closed");
    if (!reconnectTimer) reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      try { connect(); } catch (e) { recordError(e); }
    }, 5000);
  });
  ws.addEventListener("error", () => {
    log("binance_ws_error");
    writeStatus("DELAYED", "websocket error");
  });
  ws.addEventListener("message", async event => {
    try {
      const data = JSON.parse(event.data).data;
      const symbol = data?.s?.toUpperCase();
      const asset = state.assets.find(x => x.symbol + "USDT" === symbol);
      if (!asset) return;
      const receivedAt = new Date().toISOString();

      if (data.e === "trade") {
        state.lastTrade = receivedAt;
        state.counts.trades++;
        await sb("trades", "POST", {}, {
          asset_id: asset.id, exchange: "BINANCE", trade_id: String(data.t),
          observed_at: new Date(data.T).toISOString(), price: Number(data.p),
          quantity: Number(data.q), side: data.m ? "SELL" : "BUY",
          is_buyer_maker: Boolean(data.m), status: "LIVE",
          metadata: { symbol, received_at: receivedAt }
        });
      } else if (data.e === "depthUpdate") {
        const bid = data.b?.[0], ask = data.a?.[0];
        if (!bid || !ask) return;
        const bp = Number(bid[0]), bq = Number(bid[1]);
        const ap = Number(ask[0]), aq = Number(ask[1]);
        const mid = (bp + ap) / 2;
        const imbalance = (bq - aq) / (bq + aq || 1);
        const spreadBps = ((ap - bp) / mid) * 10000;
        state.lastBook = receivedAt;
        state.counts.books++;
        await sb("orderbook_snapshots", "POST", {}, {
          asset_id: asset.id, exchange: "BINANCE",
          observed_at: new Date(data.E).toISOString(),
          best_bid: bp, best_ask: ap, spread_bps: spreadBps,
          bid_depth: bp * bq, ask_depth: ap * aq, imbalance,
          depth_levels: 20, status: "LIVE",
          metadata: { symbol, received_at: receivedAt }
        });
      }
    } catch (e) { recordError(e); }
  });
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
  for (const asset of state.assets.slice(0, 30)) {
    try {
      const r = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=" + asset.symbol + "USDT");
      if (!r.ok) continue;
      const x = await r.json();
      const now = new Date().toISOString();
      await sb("funding", "POST", {}, {
        asset_id: asset.id, exchange: "BINANCE", observed_at: now,
        funding_rate: Number(x.lastFundingRate),
        next_funding_at: new Date(Number(x.nextFundingTime)).toISOString(),
        mark_price: Number(x.markPrice), index_price: Number(x.indexPrice), status: "LIVE"
      });
      state.lastDeriv = now;
      state.counts.derivatives++;
    } catch (e) { recordError(e); }
  }
}

async function main() {
  try {
    state.bootStage = "supabase";
    log("boot_supabase");
    await writeStatus("CONNECTING", "boot");

    state.bootStage = "universe";
    await refreshUniverse();

    state.bootStage = "binance_ws";
    connect();

    state.bootStage = "derivatives";
    await refreshDerivatives();

    setInterval(() => refreshUniverse().catch(e => { recordError(e); writeStatus("DELAYED", e.message); }), 10 * 60 * 1000);
    setInterval(() => refreshDerivatives().catch(recordError), 60 * 1000);
    setInterval(() => {
      const fresh = state.lastTrade && Date.now() - Date.parse(state.lastTrade) < 15000;
      writeStatus(fresh ? "LIVE" : "STALE", "heartbeat");
    }, 15000);

    state.bootStage = "ready";
    state.ready = true;
    log("engine_ready", { assets: state.assets.length });
    await writeStatus("LIVE", "engine ready");
  } catch (e) {
    state.bootStage = "failed";
    state.ready = false;
    recordError(e);
    await writeStatus("UNAVAILABLE", String(e?.message || e));
    log("engine_boot_failed");
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
