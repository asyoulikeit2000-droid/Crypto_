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
const state = { startedAt: new Date().toISOString(), lastTrade: null, lastBook: null, lastDeriv: null, assets: [], errors: [], counts: { trades: 0, books: 0, derivatives: 0 } };

function recordError(e) { state.errors.push(String(e?.message || e)); state.errors = state.errors.slice(-10); }

async function sb(table, method = "GET", params = {}, body) {
  if (!SB || !KEY) throw new Error("Supabase credentials not configured");
  const u = new URL(SB + "/rest/v1/" + table);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const h = { apikey: KEY, "Accept-Profile": SCHEMA };
  if (method !== "GET") { h["Content-Type"] = "application/json"; h["Content-Profile"] = SCHEMA; h.Prefer = "return=minimal"; }
  const r = await fetch(u, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error("Supabase " + r.status + " " + await r.text());
  const t = await r.text(); return t ? JSON.parse(t) : [];
}

async function writeStatus(status, message = null) {
  try {
    await sb("provider_status", "POST", { on_conflict: "provider,dataset" }, {
      provider: "BINANCE", dataset: "engine", checked_at: new Date().toISOString(),
      status, last_event_at: new Date().toISOString(), error_message: message, metadata: {}
    });
  } catch (e) { recordError(e); }
}

async function refreshUniverse() {
  const r = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false");
  if (!r.ok) throw new Error("CoinGecko " + r.status);
  const coins = (await r.json()).filter(x => !x.symbol?.includes("usd") && !x.name?.toLowerCase().includes("wrapped")).slice(0, 30);
  for (const x of coins) {
    try {
      await sb("assets", "POST", { on_conflict: "asset_id" }, {
        asset_id: x.id, symbol: x.symbol.toUpperCase(), name: x.name,
        base_asset: x.symbol.toUpperCase(), quote_asset: "USD", asset_type: "spot",
        active: true, last_seen_at: new Date().toISOString(),
        metadata: { rank: x.market_cap_rank, market_cap_usd: x.market_cap, current_price: x.current_price }
      });
    } catch (e) { recordError(e); }
  }
  state.assets = coins.map(x => ({ id: x.id, symbol: x.symbol.toUpperCase(), rank: x.market_cap_rank }));
}

function connect() {
  const symbols = state.assets.map(x => x.symbol.toLowerCase() + "usdt").slice(0, 30);
  const streams = symbols.flatMap(s => [s + "@trade", s + "@depth20@100ms"]);
  const ws = new WebSocket("wss://fstream.binance.com/stream?streams=" + streams.join("/"));
  ws.addEventListener("open", () => writeStatus("LIVE", "streams connected"));
  ws.addEventListener("close", () => { writeStatus("STALE", "websocket closed"); setTimeout(connect, 5000); });
  ws.addEventListener("error", () => writeStatus("DELAYED", "websocket error"));
  ws.addEventListener("message", async event => {
    try {
      const data = JSON.parse(event.data).data;
      const symbol = data?.s?.toUpperCase();
      const asset = state.assets.find(x => x.symbol + "USDT" === symbol);
      if (!asset) return;
      const receivedAt = new Date().toISOString();
      if (data.e === "trade") {
        state.lastTrade = receivedAt; state.counts.trades++;
        await sb("trades", "POST", {}, {
          asset_id: asset.id, exchange: "BINANCE", trade_id: String(data.t),
          observed_at: new Date(data.T).toISOString(), price: Number(data.p),
          quantity: Number(data.q), side: data.m ? "SELL" : "BUY",
          is_buyer_maker: Boolean(data.m), status: "LIVE",
          metadata: { symbol, received_at: receivedAt }
        });
      } else if (data.e === "depthUpdate") {
        const bid = data.b?.[0], ask = data.a?.[0]; if (!bid || !ask) return;
        const bp = Number(bid[0]), bq = Number(bid[1]), ap = Number(ask[0]), aq = Number(ask[1]);
        const mid = (bp + ap) / 2, imbalance = (bq - aq) / (bq + aq || 1), spreadBps = ((ap - bp) / mid) * 10000;
        state.lastBook = receivedAt; state.counts.books++;
        await sb("orderbook_snapshots", "POST", {}, {
          asset_id: asset.id, exchange: "BINANCE", observed_at: new Date(data.E).toISOString(),
          best_bid: bp, best_ask: ap, spread_bps: spreadBps, bid_depth: bp * bq,
          ask_depth: ap * aq, imbalance, depth_levels: 20, status: "LIVE",
          metadata: { symbol, received_at: receivedAt }
        });
      }
    } catch (e) { recordError(e); }
  });
}

async function safeRead(table, params = {}) { try { return await sb(table, "GET", params); } catch (e) { recordError(e); return []; } }
async function dashboardData() { const [signals,paperTrades,providers]=await Promise.all([safeRead("latest_signals",{select:"*",limit:"50"}),safeRead("latest_paper_trades",{select:"*",limit:"50"}),safeRead("provider_status",{select:"*",limit:"20"})]); return {generatedAt:new Date().toISOString(),health:{ok:true,mode:"live",startedAt:state.startedAt,assets:state.assets.length,lastTrade:state.lastTrade,lastBook:state.lastBook,lastDeriv:state.lastDeriv,counts:state.counts,errors:state.errors.slice(-5)},assets:state.assets,signals,paperTrades,providers}; }
function sendJson(res,value,status=200){res.statusCode=status;res.setHeader("content-type","application/json; charset=utf-8");res.setHeader("cache-control","no-store");res.setHeader("x-content-type-options","nosniff");res.end(JSON.stringify(value));}
async function serveStatic(req,res){const pathname=decodeURIComponent(new URL(req.url,"http://localhost").pathname);const rel=pathname==="/"?"index.html":pathname.replace(/^\\/+/, "");const file=normalize(join(PUBLIC_DIR,rel));if(!file.startsWith(PUBLIC_DIR))return sendJson(res,{error:"not_found"},404);try{const data=await readFile(file);const ext=extname(file);const type=ext===".html"?"text/html; charset=utf-8":ext===".js"?"text/javascript; charset=utf-8":ext===".css"?"text/css; charset=utf-8":"application/octet-stream";res.statusCode=200;res.setHeader("content-type",type);res.setHeader("cache-control","no-cache");res.setHeader("x-content-type-options","nosniff");res.end(data)}catch{sendJson(res,{error:"not_found"},404)}}

async function refreshDerivatives() {
  for (const asset of state.assets.slice(0, 30)) {
    try {
      const r = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=" + asset.symbol + "USDT");
      if (!r.ok) continue;
      const x = await r.json(), now = new Date().toISOString();
      await sb("funding", "POST", {}, {
        asset_id: asset.id, exchange: "BINANCE", observed_at: now,
        funding_rate: Number(x.lastFundingRate), next_funding_at: new Date(Number(x.nextFundingTime)).toISOString(),
        mark_price: Number(x.markPrice), index_price: Number(x.indexPrice), status: "LIVE"
      });
      state.lastDeriv = now; state.counts.derivatives++;
    } catch (e) { recordError(e); }
  }
}

async function main() {
  await writeStatus("CONNECTING", "boot");
  await refreshUniverse();
  connect();
  await refreshDerivatives();
  setInterval(() => refreshUniverse().catch(e => { recordError(e); writeStatus("DELAYED", e.message); }), 10 * 60 * 1000);
  setInterval(() => refreshDerivatives().catch(recordError), 60 * 1000);
  setInterval(() => {
    const fresh = state.lastTrade && Date.now() - Date.parse(state.lastTrade) < 15000;
    writeStatus(fresh ? "LIVE" : "STALE", "heartbeat");
  }, 15000);
}

const server = http.createServer(async (req,res)=>{try{const path=new URL(req.url,"http://localhost").pathname;if(path==="/api/health")return sendJson(res,{ok:true,mode:"live",startedAt:state.startedAt,assets:state.assets.length,lastTrade:state.lastTrade,lastBook:state.lastBook,lastDeriv:state.lastDeriv,counts:state.counts,errors:state.errors.slice(-5)});if(path==="/api/market")return sendJson(res,{assets:state.assets,counts:state.counts,lastTrade:state.lastTrade,lastBook:state.lastBook,lastDeriv:state.lastDeriv});if(path==="/api/dashboard")return sendJson(res,await dashboardData());if(path==="/api/signals")return sendJson(res,await safeRead("latest_signals",{select:"*",limit:"100"}));if(path==="/api/paper")return sendJson(res,await safeRead("latest_paper_trades",{select:"*",limit:"100"}));if(path==="/api/providers")return sendJson(res,await safeRead("provider_status",{select:"*",limit:"50"}));if(path.startsWith("/api/"))return sendJson(res,{error:"not_found"},404);return serveStatic(req,res)}catch(e){recordError(e);return sendJson(res,{error:"server_error",message:String(e?.message||e)},500)}});
server.listen(PORT, HOST, () => main().catch(e => { recordError(e); writeStatus("UNAVAILABLE", e.message); }));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
