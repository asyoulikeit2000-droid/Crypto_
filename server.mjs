import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { rankEligibleUniverse } from "./universe-engine.mjs";
import { createIntelligenceEngine } from "./intelligence-engine.mjs";

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
  counts: { trades: 0, books: 0, derivatives: 0 },
  market: new Map(),
  intelligence: createIntelligenceEngine()
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
  let relay = null;
  try {
    relay = await relayJson("bootstrap");
  } catch (e) {
    recordError(e);
    relay = null;
  }

  // Primary runtime universe: all eligible USDT linear perpetuals returned by the
  // provider, dynamically ranked for entry quality. This is intentionally NOT a
  // hard-coded symbol list or a permanent Top-30 list.
  if (relay?.info?.length && relay?.tickers?.length) {
    const bookBySymbol = new Map();
    for (const [id,m] of state.market.entries()) {
      if (m.symbol) bookBySymbol.set(String(m.symbol).toUpperCase()+"USDT", {
        spreadBps:m.spreadBps, depthUsd:m.depthUsd, fresh:m.bookFresh
      });
    }
    const ranked = rankEligibleUniverse(relay.info, relay.tickers, bookBySymbol, 30);
    if (ranked.length) {
      const assets=[];
      for (const x of ranked) {
        const base=x.baseAsset;
        const assetId="bybit:"+base.toLowerCase();
        try {
          await sb("assets","POST",{on_conflict:"asset_id"},{
            asset_id:assetId,symbol:base,name:base,base_asset:base,quote_asset:"USDT",
            asset_type:"perpetual",active:true,last_seen_at:new Date().toISOString(),
            metadata:{universe_source:"dynamic_entry_eligibility",eligibility_score:x.eligibilityScore,
              turnover_24h:x.turnover24h,volume_24h:x.volume24h,spread_bps:x.spreadBps,
              depth_usd:x.depthUsd,selection_basis:x.selectionBasis}
          });
        } catch(e){ recordError(e); }
        assets.push({id:assetId,symbol:base,rank:null,eligibilityScore:x.eligibilityScore,
          universeSource:"dynamic_entry_eligibility",turnover24h:x.turnover24h});
      }
      state.assets=assets;
      log("universe_refresh_complete",{assets:assets.length,source:"dynamic_entry_eligibility"});
      return;
    }
  }

  // Secondary source: previously persisted eligible assets. Never invent a fixed list.
  const fallback=await sb("assets","GET",{select:"asset_id,symbol,metadata",active:"eq.true",limit:"100"});
  const persisted=fallback.filter(x=>x.metadata?.universe_source==="dynamic_entry_eligibility")
    .sort((a,b)=>Number(b.metadata?.eligibility_score||0)-Number(a.metadata?.eligibility_score||0)).slice(0,30);
  if(persisted.length){
    state.assets=persisted.map(x=>({id:x.asset_id,symbol:x.symbol.toUpperCase(),
      rank:null,eligibilityScore:Number(x.metadata?.eligibility_score||0),universeSource:"persisted_dynamic"}));
    log("universe_refresh_fallback",{assets:state.assets.length,source:"persisted_dynamic"});
    return;
  }
  throw new Error("No dynamic eligible universe available");
}

