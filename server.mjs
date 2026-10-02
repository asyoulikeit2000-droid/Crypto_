import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { rankEligibleUniverse } from "./universe-engine.mjs";
import { createIntelligenceEngine } from "./intelligence-engine.mjs";
import { evaluateSignalReadiness, evaluateProductionRobustness } from "./signal-gates.mjs";
import { createPreRallyScanner } from "./scanner/service.mjs";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SECRET_KEY || "";
const SCHEMA = process.env.SUPABASE_DB_SCHEMA || "engine";
const RELAY_URL = process.env.MARKET_RELAY_URL || (SB ? SB + "/functions/v1/market-data-relay" : "");
const RELAY_KEY = process.env.MARKET_RELAY_KEY || "";
const FEATURE_VERSION = "v2.1";
const MODEL_ID = "rules_v3_selective";
const H4_MODEL_ID = "rules_h4_swing_selective_v2";
const D1_MODEL_ID = "rules_d1_position_shadow_v1";
const MTF_MODEL_ID = "rules_mtf_swing_position_shadow_v1";
const H4_HORIZON_SECONDS = 4 * 60 * 60;
const D1_HORIZON_SECONDS = 24 * 60 * 60;
const TRAIN_INTERVAL_MS = 2 * 60 * 1000;
const MAX_HORIZON_SECONDS = 3600;
const PAPER_FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.00055);
const PAPER_SLIPPAGE_RATE = Number(process.env.PAPER_SLIPPAGE_RATE || 0.00015);
const FEATURE_DEFS = [
  ["return_1m","1m price return","technical","H1","Log return over recent trade prices",["market_ticks","trades"]],
  ["return_5m","5m price return","technical","H1","Log return over a five-minute window",["market_ticks","trades"]],
  ["return_15m","15m price return","technical","H1","Log return over a fifteen-minute window",["market_ticks","trades"]],
  ["realized_vol","realized volatility","technical","H1","Recent trade-price realized volatility proxy",["trades"]],
  ["cvd_2m","2m signed flow ratio","flow","H1","Signed notional flow divided by total notional over two minutes",["trades"]],
  ["cvd_10m","10m signed flow ratio","flow","H1","Signed notional flow divided by total notional over ten minutes",["trades"]],
  ["volume_2m_usd","2m volume","liquidity","H1","Trade notional observed over two minutes",["trades"]],
  ["volume_10m_usd","10m volume","liquidity","H1","Trade notional observed over ten minutes",["trades"]],
  ["orderbook_imbalance","orderbook imbalance","microstructure","H1","Top-level bid versus ask depth imbalance",["orderbook_snapshots"]],
  ["spread_bps","spread","microstructure","H1","Best bid/ask spread in basis points",["orderbook_snapshots"]],
  ["alignment","price-flow alignment","composite","H1","Directional alignment of price and signed flow",["market_ticks","trades","orderbook_snapshots"]],
  ["microstructure_quality","microstructure quality gate","quality","H1","Freshness, spread and book-balance gate",["market_ticks","orderbook_snapshots","trades"]]
];
const POLL_MS = 5000;
const UNIVERSE_REFRESH_MS = 10 * 60 * 1000;
const HORIZON_RESEARCH_INTERVAL_MS = 2 * 60 * 1000;
const VALIDATION_INTERVAL_MS = 10 * 60 * 1000;
const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;
const QUALITY_INTERVAL_MS = 60 * 1000;

const state = {
  startedAt: new Date().toISOString(),
  bootStage: "starting",
  ready: false,
  lastTrade: null,
  lastBook: null,
  lastDeriv: null,
  assets: [],
  errors: [],
  counts: { trades: 0, books: 0, derivatives: 0, ticks: 0, features: 0, signals: 0, paperTrades: 0 },
  market: new Map(),
  intelligence: createIntelligenceEngine(),
  batchCursor: 0,
  lastUniverseRefresh: null,
  lastPipelineRun: null,
  lastMarketSuccessAt: null,
  lastSupabaseSuccessAt: null,
  lastSupabaseFailureAt: null,
  lastQualityWrite: 0,
  lastSignalAt: new Map(),
  recentSignals: [],
  recentPaperTrades: [],
  killSwitch: false,
  calibration: { trainedAt: null, sampleCount: 0, globalProbability: null, byDirection: {}, status: "UNTRAINED" },
  validation: { status: "NOT_RUN" },
  lastTrainingAt: 0,
  horizonResearch: {
    H1: { modelId: MODEL_ID, state: "VALIDATING" },
    H4: { modelId: H4_MODEL_ID, state: "DATA_WARMING", readyAssets: 0, candidates: 0, outcomes: 0 },
    D1: { modelId: D1_MODEL_ID, state: "DATA_WARMING", readyAssets: 0, candidates: 0, outcomes: 0 },
    MTF: { modelId: MTF_MODEL_ID, state: "DATA_WARMING", readyAssets: 0, candidates: 0, outcomes: 0 }
  }
};

function iso(ms = Date.now()) { return new Date(ms).toISOString(); }
function minuteBucket(ms = Date.now()) {
  const d = new Date(ms);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function finite(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}
function jsonReply(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(text);
}
function log(message, meta = {}) {
  console.log(JSON.stringify({ ts: iso(), message, ...meta }));
}
function recordError(e, context = null) {
  const message = context ? context + ": " + String(e?.message || e) : String(e?.message || e);
  state.errors.push(message);
  state.errors = state.errors.slice(-20);
  console.error(JSON.stringify({ ts: iso(), error: message }));
}
function requireConfigured() {
  if (!SB || !KEY) throw new Error("Supabase credentials not configured");
  if (!RELAY_URL || !RELAY_KEY) throw new Error("Market relay not configured");
}

async function sb(table, method = "GET", params = {}, body, extraHeaders = {}) {
  requireConfigured();
  const u = new URL(SB + "/rest/v1/" + table);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  const headers = { apikey: KEY, "Accept-Profile": SCHEMA };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["Content-Profile"] = SCHEMA;
    headers.Prefer = extraHeaders.Prefer || "return=minimal";
  }
  try {
    const response = await fetch(u, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) throw new Error("Supabase " + response.status + " " + text.slice(0, 800));
    state.lastSupabaseSuccessAt = iso();
    return text ? JSON.parse(text) : [];
  } catch (e) {
    state.lastSupabaseFailureAt = iso();
    throw e;
  }
}

async function insertRows(table, rows, onConflict = null, mode = "ignore", representation = false) {
  if (!rows?.length) return [];
  const params = onConflict ? { on_conflict: onConflict } : {};
  const resolution = mode === "merge" ? "resolution=merge-duplicates" : "resolution=ignore-duplicates";
  params.Prefer = undefined;
  return sb(
    table,
    "POST",
    params,
    rows,
    { Prefer: resolution + "," + (representation ? "return=representation" : "return=minimal") }
  );
}

async function relayJson(mode, symbols = []) {
  requireConfigured();
  const u = new URL(RELAY_URL);
  u.searchParams.set("mode", mode);
  if (symbols.length) u.searchParams.set("symbols", symbols.join(","));
  const response = await fetch(u, {
    headers: {
      apikey: RELAY_KEY,
      "x-region": "ap-southeast-1"
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error("Market relay HTTP " + response.status + " " + text.slice(0, 800));
  return JSON.parse(text);
}

async function writeSystemEvent(eventType, severity, component, message, metadata = {}) {
  try {
    await sb("system_events", "POST", {}, {
      created_at: iso(),
      event_type: eventType,
      severity,
      component,
      message,
      metadata
    });
  } catch (e) {
    recordError(e, "system_event");
  }
}

async function writeAudit(action, objectType = null, objectId = null, details = {}) {
  try {
    await sb("audit_logs", "POST", {}, {
      created_at: iso(),
      actor: "system",
      action,
      object_type: objectType,
      object_id: objectId,
      details
    });
  } catch (e) {
    recordError(e, "audit");
  }
}

async function writeProviderStatus(status, message = null, dataset = "engine", latencyMs = null) {
  const payload = {
    checked_at: iso(),
    status,
    latency_ms: latencyMs,
    last_event_at: iso(),
    error_message: message,
    metadata: { runtime_revision: process.env.RUNTIME_REV || process.env.DEPLOY_REVISION || "unknown" }
  };
  try {
    await sb("provider_status", "POST", { on_conflict: "provider,dataset" }, {
      provider: "BYBIT_RELAY",
      dataset,
      ...payload
    }, { Prefer: "resolution=merge-duplicates,return=minimal" });
  } catch (e) {
    recordError(e, "provider_status");
  }
}

async function ensureFeatureRegistry() {
  const rows = FEATURE_DEFS.map(([feature_id, feature_name, family, horizon, definition, source_tables]) => ({
    feature_id,
    feature_name,
    family,
    horizon,
    definition,
    source_tables,
    validation_status: "VALIDATED",
    enabled: true,
    version: FEATURE_VERSION
  }));
  await sb("feature_registry", "POST", { on_conflict: "feature_id" }, rows, {
    Prefer: "resolution=merge-duplicates,return=minimal"
  });
}

async function ensureModel() {
  await sb("model_versions", "POST", { on_conflict: "model_id" }, {
    model_id: MODEL_ID,
    model_family: "deterministic_evidence_rules",
    target_definition: "1R/2R/3R forward setup qualification",
    horizon: "H1",
    feature_version: FEATURE_VERSION,
    training_window: { type: "rule_engine", note: "No opaque ML prediction is claimed." },
    hyperparameters: {
      min_alignment: 0.25,
      min_probability_t1: 0.70,
      max_spread_bps: 12,
      max_stale_ms: 20000
    },
    validation_metrics: {},
    calibration_method: null,
    status: "PRODUCTION_RULES"
  }, { Prefer: "resolution=merge-duplicates,return=minimal" });

  for (const spec of [
    { id: H4_MODEL_ID, horizon: "H4", family: "deterministic_swing_rules", target: "4h swing continuation shadow qualification" },
    { id: D1_MODEL_ID, horizon: "D1", family: "deterministic_position_rules", target: "24h positional continuation shadow qualification" },
    { id: MTF_MODEL_ID, horizon: "H4", family: "deterministic_multitimeframe_rules", target: "D1 directional context + H4 setup + H1 entry timing shadow qualification" }
  ]) {
    await sb("model_versions", "POST", { on_conflict: "model_id" }, {
      model_id: spec.id,
      model_family: spec.family,
      target_definition: spec.target,
      horizon: spec.horizon,
      feature_version: FEATURE_VERSION,
      training_window: { type: "shadow_evidence_collection", note: "No live execution; independent horizon validation required." },
      hyperparameters: {},
      validation_metrics: {},
      calibration_method: null,
      status: "SHADOW_DATA_WARMING"
    }, { Prefer: "resolution=merge-duplicates,return=minimal" });
  }
}

async function trainCalibration(force = false) {
  const now = Date.now();
  if (!force && now - state.lastTrainingAt < TRAIN_INTERVAL_MS) return state.calibration;
  state.lastTrainingAt = now;
  try {
    const rows = await sb("signal_outcomes", "GET", {
      select: "signal_id,outcome,t1_hit,evaluation_version,holding_seconds",
      limit: "5000"
    });
    const usable = rows.filter(x =>
      x.evaluation_version === "paper_v2" ||
      (x.evaluation_version === "paper_v1" && Number(x.holding_seconds || 0) <= MAX_HORIZON_SECONDS)
    );
    const ids = usable.map(x => x.signal_id);
    if (!ids.length) {
      state.calibration = { ...state.calibration, trainedAt: iso(), sampleCount: 0, status: "WAITING_FOR_OUTCOMES" };
      return state.calibration;
    }

    const signals = await sb("signals", "GET", {
      select: "signal_id,signal,p_t1,expected_value,model_id",
      signal_id: "in.(" + ids.join(",") + ")",
      model_id: "eq." + MODEL_ID,
      limit: "5000"
    });
    const byId = new Map(signals.map(x => [x.signal_id, x]));
    const buckets = Array.from({ length: 8 }, (_, i) => ({
      lower: 0.50 + i * 0.05, upper: 0.55 + i * 0.05, n: 0, wins: 0
    }));
    let wins = 0, brier = 0, used = 0;
    const dir = { LONG: { n: 0, w: 0 }, SHORT: { n: 0, w: 0 } };

    for (const o of usable) {
      const s = byId.get(o.signal_id);
      if (!s) continue;
      const p = clamp(finite(s.p_t1, 0.5), 0, 1);
      const win = Boolean(o.t1_hit);
      const y = win ? 1 : 0;
      wins += y; used++;
      brier += (p - y) ** 2;
      const d = String(s.signal || "");
      if (dir[d]) { dir[d].n++; dir[d].w += y; }
      const idx = Math.min(7, Math.max(0, Math.floor((p - 0.50) / 0.05)));
      buckets[idx].n++;
      buckets[idx].wins += y;
    }

    const priorMean = 0.20, priorStrength = 12;
    const smooth = (w, n) => (w + priorMean * priorStrength) / (n + priorStrength);
    const bins = buckets.map(b => ({
      lower: b.lower,
      upper: b.upper,
      n: b.n,
      wins: b.wins,
      observed_rate: b.n ? b.wins / b.n : null,
      calibrated_rate: b.n ? smooth(b.wins, b.n) : null
    }));
    const global = used ? smooth(wins, used) : null;
    const calibrationActive = used >= 50 && Number.isFinite(brier) && Number.isFinite(global);
    state.calibration = {
      trainedAt: iso(),
      sampleCount: used,
      globalProbability: global,
      byDirection: {
        LONG: dir.LONG.n ? smooth(dir.LONG.w, dir.LONG.n) : global,
        SHORT: dir.SHORT.n ? smooth(dir.SHORT.w, dir.SHORT.n) : global
      },
      rawWinRate: used ? wins / used : null,
      brierScore: used ? brier / used : null,
      bins,
      status: calibrationActive ? "ACTIVE" : (used >= 50 ? "EDGE_NOT_CONFIRMED" : "WARMING")
    };

    await sb("model_calibrations", "POST", { on_conflict: "calibration_id" }, {
      calibration_id: MODEL_ID + ":" + Date.now(),
      model_id: MODEL_ID,
      method: "bayesian_probability_binning",
      trained_at: iso(),
      metrics: {
        sample_count: used,
        raw_win_rate: state.calibration.rawWinRate,
        brier_score: state.calibration.brierScore,
        global_probability: global,
        status: state.calibration.status
      },
      bins,
      active: calibrationActive
    }, { Prefer: "resolution=merge-duplicates,return=minimal" });

    await sb("model_versions", "PATCH", { model_id: "eq." + MODEL_ID }, {
      validation_metrics: {
        calibration: state.calibration,
      validation: state.validation,
        note: "Outcome calibration from horizon-valid paper outcomes; calibration is activated only when minimum sample and positive-edge criteria are met."
      },
      calibration_method: "bayesian_probability_binning",
      training_window: {
        type: "online_outcome_calibration",
        sample_count: used,
        max_horizon_seconds: MAX_HORIZON_SECONDS
      },
      status: calibrationActive ? "PRODUCTION_RULES_CALIBRATED" : "SHADOW_CALIBRATING"
    });
    return state.calibration;
  } catch (e) {
    recordError(e, "calibration_train");
    return state.calibration;
  }
}

async function runWalkForwardValidation() {
  try {
    const modelSignals = await sb("signals", "GET", {
      select: "signal_id",
      model_id: "eq." + MODEL_ID,
      limit: "5000"
    });
    const modelSignalIds = new Set(modelSignals.map(x => x.signal_id));
    const rows = await sb("signal_outcomes", "GET", {
      select: "signal_id,evaluated_at,outcome,pnl_after_cost,holding_seconds,evaluation_version",
      order: "evaluated_at.asc",
      limit: "5000"
    });
    const usable = rows.filter(x => modelSignalIds.has(x.signal_id) &&
      (x.evaluation_version === "paper_v2" || (x.evaluation_version === "paper_v1" && Number(x.holding_seconds || 0) <= MAX_HORIZON_SECONDS))
    );
    if (usable.length < 20) {
      state.validation = { status: "INSUFFICIENT_SAMPLE", sampleCount: usable.length };
      return state.validation;
    }
    const split = Math.max(10, Math.floor(usable.length * 0.70));
    const train = usable.slice(0, split);
    const test = usable.slice(split);
    const metrics = part => {
      const wins = part.filter(x => ["TARGET_1","TARGET_2","TARGET_3"].includes(x.outcome)).length;
      const pnls = part.map(x => finite(x.pnl_after_cost));
      const avg = pnls.length ? pnls.reduce((a,b)=>a+b,0)/pnls.length : 0;
      let equity = 0, peak = 0, maxDrawdown = 0;
      for (const p of pnls) {
        equity += p;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.max(maxDrawdown, peak - equity);
      }
      return { n: part.length, wins, winRate: part.length ? wins/part.length : 0, avgPnl: avg, totalPnl: pnls.reduce((a,b)=>a+b,0), maxDrawdown };
    };
    const foldCount = 5;
    const folds = [];
    for (let i = 0; i < foldCount; i++) {
      const from = Math.floor(i * usable.length / foldCount);
      const to = Math.floor((i + 1) * usable.length / foldCount);
      folds.push({ index: i + 1, ...metrics(usable.slice(from, to)) });
    }
    const foldAvgs = folds.map(x => x.avgPnl).sort((a,b)=>a-b);
    const medianAvgPnl = foldAvgs[Math.floor(foldAvgs.length / 2)] || 0;
    const recentFolds = folds.slice(-3);
    const recentTotalPnl = recentFolds.reduce((sum,x)=>sum + x.totalPnl, 0);
    const robustness = {
      foldCount,
      positiveFolds: folds.filter(x => x.avgPnl > 0 && x.totalPnl > 0).length,
      medianAvgPnl,
      recentTotalPnl,
      folds
    };
    state.validation = {
      status: "COMPLETE",
      evaluatedAt: iso(),
      sampleCount: usable.length,
      split: { train: train.length, test: test.length, method: "chronological_70_30" },
      train: metrics(train),
      test: metrics(test),
      robustness
    };
    const run = await sb("backtest_runs", "POST", {}, {
      started_at: iso(),
      finished_at: iso(),
      universe_methodology: "recorded_signal_set",
      target_definition: "H1 terminal outcome",
      model_id: MODEL_ID,
      config: { type: "walk_forward_validation", train_fraction: 0.70, max_horizon_seconds: MAX_HORIZON_SECONDS },
      metrics: state.validation,
      status: "COMPLETE"
    }, { Prefer: "return=representation" });
    state.validation.runId = run?.[0]?.run_id || null;
    await sb("model_versions", "PATCH", { model_id: "eq." + MODEL_ID }, {
      validation_metrics: {
        calibration: state.calibration,
        validation: state.validation,
        note: "Calibration measures T1 hit probability for this model only; walk-forward validation measures model-specific paper PnL."
      }
    });
    return state.validation;
  } catch (e) {
    recordError(e, "walk_forward_validation");
    state.validation = { status: "FAILED", error: String(e?.message || e) };
    return state.validation;
  }
}

async function readKillSwitch() {
  try {
    const rows = await sb("kill_switch", "GET", { select: "enabled,reason", id: "eq.1", limit: "1" });
    state.killSwitch = Boolean(rows?.[0]?.enabled);
    return rows?.[0] || { enabled: false };
  } catch (e) {
    recordError(e, "kill_switch_read");
    state.killSwitch = true;
    return { enabled: true, reason: "kill switch status unavailable" };
  }
}

async function persistUniverseSnapshot(ranked, provider = "BYBIT_RELAY") {
  const snapshotRows = await sb("universe_snapshots", "POST", {}, {
    captured_at: iso(),
    universe_name: "top30_dynamic",
    methodology_version: "entry_eligibility_v2",
    provider,
    metadata: {
      asset_count: ranked.length,
      ranking: "liquidity + volume + spread + depth + freshness - funding pressure"
    }
  }, { Prefer: "return=representation" });
  const snapshotId = snapshotRows?.[0]?.snapshot_id;
  if (!snapshotId) throw new Error("Universe snapshot insert returned no snapshot_id");

  const members = ranked.map((x, i) => ({
    snapshot_id: snapshotId,
    asset_id: "bybit:" + x.baseAsset.toLowerCase(),
    rank: i + 1,
    market_cap: null,
    eligibility_status: "ELIGIBLE",
    exclusion_reason: null
  }));
  await sb("universe_members", "POST", {}, members, { Prefer: "return=minimal" });
  return snapshotId;
}

async function refreshUniverse() {
  const started = Date.now();
  log("universe_refresh_start");
  let relay;
  try {
    relay = await relayJson("bootstrap");
  } catch (e) {
    await writeProviderStatus("DEGRADED", String(e?.message || e), "universe", Date.now() - started);
    recordError(e, "universe_bootstrap");
    relay = null;
  }

  if (relay?.info?.length && relay?.tickers?.length) {
    const bookBySymbol = new Map();
    for (const entry of state.market.values()) {
      if (entry?.symbol) {
        bookBySymbol.set(String(entry.symbol).toUpperCase() + "USDT", {
          spreadBps: entry.spreadBps,
          depthUsd: entry.depthUsd,
          fresh: Boolean(entry.bookFresh)
        });
      }
    }
    const ranked = rankEligibleUniverse(relay.info, relay.tickers, bookBySymbol, 30);
    if (ranked.length >= 5) {
      const assets = [];
      for (const x of ranked) {
        const base = String(x.baseAsset).toUpperCase();
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
            last_seen_at: iso(),
            metadata: {
              universe_source: "dynamic_entry_eligibility",
              eligibility_score: x.eligibilityScore,
              turnover_24h: x.turnover24h,
              volume_24h: x.volume24h,
              spread_bps: x.spreadBps,
              depth_usd: x.depthUsd,
              selection_basis: x.selectionBasis
            }
          }, { Prefer: "resolution=merge-duplicates,return=minimal" });
        } catch (e) {
          recordError(e, "asset_upsert");
        }
        assets.push({
          id: assetId,
          symbol: base,
          rank: null,
          eligibilityScore: x.eligibilityScore,
          universeSource: "dynamic_entry_eligibility",
          turnover24h: x.turnover24h
        });
      }
      state.assets = assets;
      try {
        await persistUniverseSnapshot(ranked);
      } catch (e) {
        recordError(e, "universe_snapshot");
      }
      state.lastUniverseRefresh = iso();
      await writeProviderStatus("OK", null, "universe", Date.now() - started);
      log("universe_refresh_complete", { assets: assets.length, source: "dynamic_entry_eligibility" });
      return assets;
    }
  }

  const fallback = await sb("assets", "GET", {
    select: "asset_id,symbol,metadata,active",
    active: "eq.true",
    limit: "100"
  });
  const persisted = fallback
    .filter(x => x.metadata?.universe_source === "dynamic_entry_eligibility")
    .sort((a, b) => finite(b.metadata?.eligibility_score) - finite(a.metadata?.eligibility_score))
    .slice(0, 30);

  if (persisted.length) {
    state.assets = persisted.map(x => ({
      id: x.asset_id,
      symbol: String(x.symbol).toUpperCase(),
      rank: null,
      eligibilityScore: finite(x.metadata?.eligibility_score),
      universeSource: "persisted_dynamic"
    }));
    state.lastUniverseRefresh = iso();
    log("universe_refresh_fallback", { assets: state.assets.length, source: "persisted_dynamic" });
    return state.assets;
  }

  throw new Error("No dynamic eligible universe available");
}

function normalizeBook(asset, raw) {
  const bidLevels = Array.isArray(raw?.b) ? raw.b : [];
  const askLevels = Array.isArray(raw?.a) ? raw.a : [];
  const bid = bidLevels[0] ? finite(bidLevels[0][0]) : null;
  const ask = askLevels[0] ? finite(askLevels[0][0]) : null;
  const bidDepth = bidLevels.reduce((sum, x) => sum + finite(x?.[0]) * finite(x?.[1]), 0);
  const askDepth = askLevels.reduce((sum, x) => sum + finite(x?.[0]) * finite(x?.[1]), 0);
  const denom = bidDepth + askDepth;
  const imbalance = denom ? (bidDepth - askDepth) / denom : 0;
  const spreadBps = bid && ask && bid > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 10000 : null;
  return {
    asset_id: asset.id,
    exchange: "BYBIT",
    observed_at: iso(Number(raw?.ts) || Date.now()),
    best_bid: bid,
    best_ask: ask,
    spread_bps: spreadBps,
    bid_depth: bidDepth,
    ask_depth: askDepth,
    imbalance,
    depth_levels: Math.max(bidLevels.length, askLevels.length),
    status: "LIVE",
    metadata: { symbol: asset.symbol, source: "bybit_relay" }
  };
}

function klineRows(asset, list) {
  return (Array.isArray(list) ? list : []).map(k => ({
    asset_id: asset.id,
    exchange: "BYBIT",
    timeframe: "1m",
    bucket_start: iso(Number(k?.[0]) || Date.now()),
    open: finite(k?.[1]),
    high: finite(k?.[2]),
    low: finite(k?.[3]),
    close: finite(k?.[4]),
    volume: finite(k?.[5]),
    trade_count: null,
    status: "LIVE"
  })).filter(x => x.open > 0 && x.high > 0 && x.low > 0 && x.close > 0);
}

function barBefore(bars, targetMs) {
  let found = null;
  for (const b of bars) {
    const t = Date.parse(b.bucket_start);
    if (!Number.isFinite(t)) continue;
    if (t <= targetMs) found = b;
    else break;
  }
  return found;
}

function meanNumbers(values) {
  const xs = values.map(Number).filter(Number.isFinite);
  return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
}


async function evaluateHorizonModel(modelId) {
  try {
    const signals = await sb("signals", "GET", {
      select: "signal_id,signal,p_t1,created_at",
      model_id: "eq." + modelId,
      order: "created_at.asc",
      limit: "5000"
    });
    const signalById = new Map(signals.map(x => [x.signal_id, x]));
    if (!signals.length) {
      const calibration = { status: "WARMING", sampleCount: 0, rawWinRate: null, brierScore: null };
      const validation = { status: "INSUFFICIENT_SAMPLE", sampleCount: 0, test: { n: 0, winRate: 0, avgPnl: 0, totalPnl: 0 } };
      return { calibration, validation, gate: evaluateSignalReadiness(calibration, validation) };
    }

    const outcomes = await sb("signal_outcomes", "GET", {
      select: "signal_id,evaluated_at,outcome,t1_hit,pnl_after_cost",
      order: "evaluated_at.asc",
      limit: "5000"
    });
    const usable = outcomes.filter(x => signalById.has(x.signal_id));
    let wins = 0, brier = 0;
    const dir = { LONG: { n: 0, w: 0 }, SHORT: { n: 0, w: 0 } };
    for (const o of usable) {
      const s = signalById.get(o.signal_id);
      const p = clamp(finite(s?.p_t1, 0.5), 0, 1);
      const y = o.t1_hit ? 1 : 0;
      wins += y;
      brier += (p - y) ** 2;
      const d = String(s?.signal || "").toUpperCase();
      if (dir[d]) { dir[d].n++; dir[d].w += y; }
    }
    const priorMean = 0.20, priorStrength = 12;
    const smooth = (w, n) => (w + priorMean * priorStrength) / (n + priorStrength);
    const calibration = {
      status: usable.length >= 50 ? "ACTIVE" : "WARMING",
      sampleCount: usable.length,
      rawWinRate: usable.length ? wins / usable.length : null,
      brierScore: usable.length ? brier / usable.length : null,
      globalProbability: usable.length ? smooth(wins, usable.length) : null,
      byDirection: {
        LONG: dir.LONG.n ? smooth(dir.LONG.w, dir.LONG.n) : null,
        SHORT: dir.SHORT.n ? smooth(dir.SHORT.w, dir.SHORT.n) : null
      }
    };

    const metrics = part => {
      const pnls = part.map(x => finite(x.pnl_after_cost));
      const partWins = part.filter(x => ["TARGET_1","TARGET_2","TARGET_3"].includes(String(x.outcome || ""))).length;
      return {
        n: part.length,
        wins: partWins,
        winRate: part.length ? partWins / part.length : 0,
        avgPnl: pnls.length ? pnls.reduce((a,b)=>a+b,0) / pnls.length : 0,
        totalPnl: pnls.reduce((a,b)=>a+b,0)
      };
    };

    let validation;
    if (usable.length < 20) {
      validation = { status: "INSUFFICIENT_SAMPLE", sampleCount: usable.length, test: metrics([]) };
    } else {
      const split = Math.max(10, Math.floor(usable.length * 0.70));
      const train = usable.slice(0, split);
      const test = usable.slice(split);
      validation = {
        status: "COMPLETE",
        evaluatedAt: iso(),
        sampleCount: usable.length,
        split: { train: train.length, test: test.length, method: "chronological_70_30" },
        train: metrics(train),
        test: metrics(test)
      };
    }
    const gate = evaluateSignalReadiness(calibration, validation);

    if (usable.length) {
      await sb("model_calibrations", "POST", { on_conflict: "calibration_id" }, {
        calibration_id: modelId + ":shadow:" + usable.length,
        model_id: modelId,
        method: "shadow_bayesian_outcome_calibration",
        trained_at: iso(),
        metrics: {
          sample_count: calibration.sampleCount,
          raw_win_rate: calibration.rawWinRate,
          brier_score: calibration.brierScore,
          global_probability: calibration.globalProbability,
          status: calibration.status,
          signal_ready: gate.ready
        },
        bins: [],
        active: gate.ready
      }, { Prefer: "resolution=merge-duplicates,return=minimal" });
    }
    return { calibration, validation, gate };
  } catch (e) {
    recordError(e, "horizon_model_evidence:" + modelId);
    const calibration = { status: "FAILED", sampleCount: 0 };
    const validation = { status: "FAILED", test: { n: 0, avgPnl: 0, totalPnl: 0 } };
    return { calibration, validation, gate: evaluateSignalReadiness(calibration, validation), error: String(e?.message || e) };
  }
}

function h4ShadowDecision(asset, bars) {
  if (!Array.isArray(bars) || bars.length < 180) return { action: "NO TRADE", reason: "h4_insufficient_bars" };
  const now = Date.now();
  const latest = bars.at(-1);
  const b1h = barBefore(bars, now - 60 * 60 * 1000);
  const b4h = barBefore(bars, now - 4 * 60 * 60 * 1000);
  if (!latest || !b1h || !b4h) return { action: "NO TRADE", reason: "h4_coverage_gap" };

  const price = finite(state.market.get(asset.id)?.price || latest.close);
  const c1 = finite(b1h.close), c4 = finite(b4h.close);
  if (!price || !c1 || !c4) return { action: "NO TRADE", reason: "h4_price_missing" };

  const r1h = Math.log(price / c1);
  const r4h = Math.log(price / c4);
  const recent = bars.filter(b => Date.parse(b.bucket_start) >= now - 60 * 60 * 1000);
  const prior = bars.filter(b => {
    const t = Date.parse(b.bucket_start);
    return t >= now - 2 * 60 * 60 * 1000 && t < now - 60 * 60 * 1000;
  });
  const recentVol = meanNumbers(recent.map(x => x.volume));
  const priorVol = meanNumbers(prior.map(x => x.volume));
  const volumeRatio = priorVol > 0 ? recentVol / priorVol : 1;
  const avgRange = meanNumbers(recent.map(x => {
    const close = finite(x.close);
    return close > 0 ? (finite(x.high) - finite(x.low)) / close : 0;
  }));

  let pathMove = 0;
  for (let i=1;i<bars.length;i++) {
    if (Date.parse(bars[i].bucket_start) < now - 4 * 60 * 60 * 1000) continue;
    const a = finite(bars[i-1].close), b = finite(bars[i].close);
    if (a > 0 && b > 0) pathMove += Math.abs(Math.log(b/a));
  }
  const efficiency = pathMove > 0 ? clamp(Math.abs(r4h) / pathMove, 0, 1) : 0;
  const market = state.market.get(asset.id) || {};
  const spread = finite(market.spreadBps, 999);
  const fresh = Boolean(market.updatedAt && Date.now() - market.updatedAt < 20000);

  if (!fresh || spread >= 10) return { action: "NO TRADE", reason: "h4_market_quality" };
  if (Math.sign(r1h) !== Math.sign(r4h) || Math.abs(r4h) < 0.004 || Math.abs(r1h) < 0.001) {
    return { action: "NO TRADE", reason: "h4_trend_alignment" };
  }
  if (efficiency < 0.12) return { action: "NO TRADE", reason: "h4_low_trend_efficiency" };

  const direction = r4h > 0 ? "LONG" : "SHORT";
  const sign = direction === "LONG" ? 1 : -1;
  const riskPct = clamp(Math.max(0.005, avgRange * 2.5), 0.005, 0.03);
  const rawP = clamp(0.52 + Math.min(0.14, Math.abs(r4h) * 5) + Math.min(0.05, Math.max(0, volumeRatio - 1) * 0.04) + efficiency * 0.08, 0.52, 0.82);
  if (rawP < 0.70) return { action: "NO TRADE", reason: "h4_probability_gate" };

  return {
    action: direction,
    horizon: "H4",
    modelId: H4_MODEL_ID,
    maxHorizonSeconds: H4_HORIZON_SECONDS,
    entry: price,
    stopLoss: price * (1 - sign * riskPct),
    target1: price * (1 + sign * riskPct),
    target2: price * (1 + sign * riskPct * 2),
    target3: price * (1 + sign * riskPct * 3),
    pT1: rawP,
    pT2: clamp(rawP * 0.76, 0.30, 0.72),
    pT3: clamp(rawP * 0.56, 0.20, 0.62),
    expectedValue: rawP * riskPct - (1 - rawP) * riskPct,
    riskState: "SHADOW",
    reasons: ["h4_price_alignment","h4_trend_efficiency","h4_liquidity_pass","shadow_validation_only"],
    research: { r1h, r4h, volumeRatio, efficiency, avgRange, bars: bars.length }
  };
}

async function maybeWriteH4Shadow(asset, bars) {
  if (state.killSwitch) return null;
  const decision = h4ShadowDecision(asset, bars);
  if (decision.action === "NO TRADE") return null;
  const cooldownKey = "H4:" + asset.id;
  const prior = state.lastSignalAt.get(cooldownKey) || 0;
  if (Date.now() - prior < 30 * 60 * 1000) return null;

  const snapshot = {
    feature_version: FEATURE_VERSION,
    model_id: H4_MODEL_ID,
    generated_at: iso(),
    signal_mode: "SHADOW",
    asset: asset.symbol,
    horizon: "H4",
    research: decision.research
  };

  await sb("setup_candidates", "POST", {}, {
    asset_id: asset.id,
    detected_at: iso(),
    horizon: "H4",
    direction: decision.action,
    setup_type: "swing_momentum_continuation",
    status: "CANDIDATE",
    evidence: { reasons: decision.reasons, probability_t1: decision.pT1, ...decision.research },
    feature_snapshot: snapshot,
    expires_at: iso(Date.now() + 60 * 60 * 1000)
  });

  await sb("model_predictions", "POST", {}, {
    model_id: H4_MODEL_ID,
    asset_id: asset.id,
    predicted_at: iso(),
    direction: decision.action,
    p_t1: decision.pT1,
    p_t2: decision.pT2,
    p_t3: decision.pT3,
    expected_return: decision.expectedValue,
    expected_loss: Math.max(0, 1 - decision.pT1),
    calibration_version: "shadow_uncalibrated",
    feature_snapshot: snapshot
  });

  const rows = await sb("signals", "POST", {}, {
    asset_id: asset.id,
    created_at: iso(),
    horizon: "H4",
    signal: decision.action,
    entry: decision.entry,
    stop_loss: decision.stopLoss,
    target_1: decision.target1,
    target_2: decision.target2,
    target_3: decision.target3,
    p_t1: decision.pT1,
    p_t2: decision.pT2,
    p_t3: decision.pT3,
    expected_value: decision.expectedValue,
    risk_state: "SHADOW",
    data_quality: "HIGH",
    model_id: H4_MODEL_ID,
    feature_version: FEATURE_VERSION,
    reasons: decision.reasons,
    snapshot,
    immutable: true
  }, { Prefer: "return=representation" });

  const signal = rows?.[0];
  if (!signal?.signal_id) return null;
  state.lastSignalAt.set(cooldownKey, Date.now());
  state.horizonResearch.H4.candidates++;
  await maybeOpenPaperTrade(signal, asset, decision);
  await writeSystemEvent("H4_SHADOW_SIGNAL_CREATED", "info", "swing_engine", asset.symbol + " " + decision.action, {
    signal_id: signal.signal_id,
    horizon: "H4",
    probability: decision.pT1
  });
  return signal;
}


function d1ShadowDecision(asset, bars, d1Anchor) {
  if (!Array.isArray(bars) || bars.length < 180 || !d1Anchor?.close) return { action: "NO TRADE", reason: "d1_insufficient_history" };
  const now = Date.now();
  const latest = bars.at(-1);
  const b1h = barBefore(bars, now - 60 * 60 * 1000);
  const b4h = barBefore(bars, now - 4 * 60 * 60 * 1000);
  if (!latest || !b1h || !b4h) return { action: "NO TRADE", reason: "d1_coverage_gap" };

  const price = finite(state.market.get(asset.id)?.price || latest.close);
  const c1 = finite(b1h.close), c4 = finite(b4h.close), c24 = finite(d1Anchor.close);
  if (!price || !c1 || !c4 || !c24) return { action: "NO TRADE", reason: "d1_price_missing" };

  const r1h = Math.log(price / c1);
  const r4h = Math.log(price / c4);
  const r24h = Math.log(price / c24);
  const recent = bars.filter(b => Date.parse(b.bucket_start) >= now - 60 * 60 * 1000);
  const prior = bars.filter(b => {
    const t = Date.parse(b.bucket_start);
    return t >= now - 2 * 60 * 60 * 1000 && t < now - 60 * 60 * 1000;
  });
  const recentVol = meanNumbers(recent.map(x => x.volume));
  const priorVol = meanNumbers(prior.map(x => x.volume));
  const volumeRatio = priorVol > 0 ? recentVol / priorVol : 1;
  const avgRange = meanNumbers(recent.map(x => {
    const close = finite(x.close);
    return close > 0 ? (finite(x.high) - finite(x.low)) / close : 0;
  }));

  let pathMove = 0;
  for (let i=1;i<bars.length;i++) {
    if (Date.parse(bars[i].bucket_start) < now - 4 * 60 * 60 * 1000) continue;
    const a = finite(bars[i-1].close), b = finite(bars[i].close);
    if (a > 0 && b > 0) pathMove += Math.abs(Math.log(b/a));
  }
  const efficiency = pathMove > 0 ? clamp(Math.abs(r4h) / pathMove, 0, 1) : 0;
  const market = state.market.get(asset.id) || {};
  const spread = finite(market.spreadBps, 999);
  const fresh = Boolean(market.updatedAt && Date.now() - market.updatedAt < 20000);

  if (!fresh || spread >= 8) return { action: "NO TRADE", reason: "d1_market_quality" };
  if (Math.sign(r1h) !== Math.sign(r4h) || Math.sign(r4h) !== Math.sign(r24h)) return { action: "NO TRADE", reason: "d1_multitimeframe_conflict" };
  if (Math.abs(r24h) < 0.015 || Math.abs(r4h) < 0.004 || Math.abs(r1h) < 0.001) return { action: "NO TRADE", reason: "d1_trend_strength" };
  if (Math.abs(r24h) > 0.25 || efficiency < 0.10 || volumeRatio < 0.65) return { action: "NO TRADE", reason: "d1_quality_gate" };

  const direction = r24h > 0 ? "LONG" : "SHORT";
  const sign = direction === "LONG" ? 1 : -1;
  const riskPct = clamp(Math.max(0.01, avgRange * 6), 0.01, 0.06);
  const rawP = clamp(
    0.50 +
    Math.min(0.12, Math.abs(r24h) * 1.5) +
    Math.min(0.08, Math.abs(r4h) * 4) +
    Math.min(0.04, Math.max(0, volumeRatio - 1) * 0.03) +
    efficiency * 0.08,
    0.50, 0.82
  );
  if (rawP < 0.62) return { action: "NO TRADE", reason: "d1_probability_gate" };

  return {
    action: direction,
    horizon: "D1",
    modelId: D1_MODEL_ID,
    maxHorizonSeconds: D1_HORIZON_SECONDS,
    entry: price,
    stopLoss: price * (1 - sign * riskPct),
    target1: price * (1 + sign * riskPct),
    target2: price * (1 + sign * riskPct * 2),
    target3: price * (1 + sign * riskPct * 3),
    pT1: rawP,
    pT2: clamp(rawP * 0.74, 0.30, 0.72),
    pT3: clamp(rawP * 0.54, 0.20, 0.62),
    expectedValue: rawP * riskPct - (1 - rawP) * riskPct,
    riskState: "SHADOW",
    reasons: ["d1_24h_4h_1h_alignment","d1_liquidity_pass","d1_trend_efficiency","shadow_validation_only"],
    research: { r1h, r4h, r24h, volumeRatio, efficiency, avgRange, bars: bars.length }
  };
}

async function maybeWriteD1Shadow(asset, bars, d1Anchor) {
  if (state.killSwitch) return null;
  const decision = d1ShadowDecision(asset, bars, d1Anchor);
  if (decision.action === "NO TRADE") return null;
  const cooldownKey = "D1:" + asset.id;
  const prior = state.lastSignalAt.get(cooldownKey) || 0;
  if (Date.now() - prior < 2 * 60 * 60 * 1000) return null;

  const snapshot = {
    feature_version: FEATURE_VERSION,
    model_id: D1_MODEL_ID,
    generated_at: iso(),
    signal_mode: "SHADOW",
    asset: asset.symbol,
    horizon: "D1",
    research: decision.research
  };

  await sb("setup_candidates", "POST", {}, {
    asset_id: asset.id,
    detected_at: iso(),
    horizon: "D1",
    direction: decision.action,
    setup_type: "position_multitimeframe_continuation",
    status: "CANDIDATE",
    evidence: { reasons: decision.reasons, probability_t1: decision.pT1, ...decision.research },
    feature_snapshot: snapshot,
    expires_at: iso(Date.now() + 6 * 60 * 60 * 1000)
  });

  await sb("model_predictions", "POST", {}, {
    model_id: D1_MODEL_ID,
    asset_id: asset.id,
    predicted_at: iso(),
    direction: decision.action,
    p_t1: decision.pT1,
    p_t2: decision.pT2,
    p_t3: decision.pT3,
    expected_return: decision.expectedValue,
    expected_loss: Math.max(0, 1 - decision.pT1),
    calibration_version: "shadow_uncalibrated",
    feature_snapshot: snapshot
  });

  const rows = await sb("signals", "POST", {}, {
    asset_id: asset.id,
    created_at: iso(),
    horizon: "D1",
    signal: decision.action,
    entry: decision.entry,
    stop_loss: decision.stopLoss,
    target_1: decision.target1,
    target_2: decision.target2,
    target_3: decision.target3,
    p_t1: decision.pT1,
    p_t2: decision.pT2,
    p_t3: decision.pT3,
    expected_value: decision.expectedValue,
    risk_state: "SHADOW",
    data_quality: "HIGH",
    model_id: D1_MODEL_ID,
    feature_version: FEATURE_VERSION,
    reasons: decision.reasons,
    snapshot,
    immutable: true
  }, { Prefer: "return=representation" });

  const signal = rows?.[0];
  if (!signal?.signal_id) return null;
  state.lastSignalAt.set(cooldownKey, Date.now());
  await maybeOpenPaperTrade(signal, asset, decision);
  await writeSystemEvent("D1_SHADOW_SIGNAL_CREATED", "info", "position_engine", asset.symbol + " " + decision.action, {
    signal_id: signal.signal_id,
    horizon: "D1",
    probability: decision.pT1
  });
  return signal;
}

function mtfShadowDecision(asset, bars, d1Anchor) {
  const h4 = h4ShadowDecision(asset, bars);
  const d1 = d1ShadowDecision(asset, bars, d1Anchor);
  const h1 = state.intelligence.features(asset.id);

  if (h4.action === "NO TRADE" || d1.action === "NO TRADE") {
    return { action: "NO TRADE", reason: "mtf_parent_setup_missing" };
  }
  if (h4.action !== d1.action) {
    return { action: "NO TRADE", reason: "mtf_h4_d1_direction_conflict" };
  }
  if (!h1?.data_fresh || !h1?.microstructure_quality) {
    return { action: "NO TRADE", reason: "mtf_h1_market_quality" };
  }

  const expectedSign = h4.action === "LONG" ? 1 : -1;
  const alignment = finite(h1.alignment);
  const r5 = finite(h1.return_5m);
  const cvd10 = finite(h1.cvd_10m);
  const spread = finite(h1.spread_bps, 999);

  if (spread >= 8) return { action: "NO TRADE", reason: "mtf_spread_gate" };
  if (expectedSign * alignment < 0.30) return { action: "NO TRADE", reason: "mtf_h1_alignment_gate" };
  if (expectedSign * r5 <= 0) return { action: "NO TRADE", reason: "mtf_h1_price_timing_conflict" };
  if (expectedSign * cvd10 < -0.05) return { action: "NO TRADE", reason: "mtf_h1_flow_conflict" };

  const direction = h4.action;
  const sign = direction === "LONG" ? 1 : -1;
  const price = finite(h1.price || h4.entry);
  const riskPct = clamp(Math.max(
    0.006,
    finite(h4.research?.avgRange) * 3.0,
    finite(h1.realized_vol) * 1.25
  ), 0.006, 0.025);

  const structuralStrength = clamp(
    0.45 * finite(h4.pT1, 0.5) +
    0.35 * finite(d1.pT1, 0.5) +
    0.20 * clamp(0.5 + expectedSign * alignment * 0.35, 0.5, 0.85),
    0.50, 0.82
  );
  if (structuralStrength < 0.62) return { action: "NO TRADE", reason: "mtf_probability_gate" };

  return {
    action: direction,
    horizon: "H4",
    modelId: MTF_MODEL_ID,
    maxHorizonSeconds: H4_HORIZON_SECONDS,
    entry: price,
    stopLoss: price * (1 - sign * riskPct),
    target1: price * (1 + sign * riskPct),
    target2: price * (1 + sign * riskPct * 2),
    target3: price * (1 + sign * riskPct * 3),
    pT1: structuralStrength,
    pT2: clamp(structuralStrength * 0.75, 0.30, 0.72),
    pT3: clamp(structuralStrength * 0.55, 0.20, 0.62),
    expectedValue: structuralStrength * riskPct - (1 - structuralStrength) * riskPct,
    riskState: "SHADOW",
    reasons: [
      "mtf_d1_direction_confirmed",
      "mtf_h4_setup_confirmed",
      "mtf_h1_entry_timing_confirmed",
      "mtf_microstructure_quality_pass",
      "shadow_validation_only"
    ],
    research: {
      d1: d1.research,
      h4: h4.research,
      h1: {
        alignment,
        return_5m: r5,
        cvd_10m: cvd10,
        spread_bps: spread,
        realized_vol: finite(h1.realized_vol)
      }
    }
  };
}

async function maybeWriteMtfShadow(asset, bars, d1Anchor) {
  if (state.killSwitch) return null;
  const decision = mtfShadowDecision(asset, bars, d1Anchor);
  if (decision.action === "NO TRADE") return null;

  const cooldownKey = "MTF:" + asset.id;
  const prior = state.lastSignalAt.get(cooldownKey) || 0;
  if (Date.now() - prior < 60 * 60 * 1000) return null;

  const snapshot = {
    feature_version: FEATURE_VERSION,
    model_id: MTF_MODEL_ID,
    generated_at: iso(),
    signal_mode: "SHADOW",
    asset: asset.symbol,
    horizon: "H4",
    research: decision.research
  };

  await sb("setup_candidates", "POST", {}, {
    asset_id: asset.id,
    detected_at: iso(),
    horizon: "H4",
    direction: decision.action,
    setup_type: "swing_position_multitimeframe_confluence",
    status: "CANDIDATE",
    evidence: { reasons: decision.reasons, probability_t1: decision.pT1, ...decision.research },
    feature_snapshot: snapshot,
    expires_at: iso(Date.now() + 2 * 60 * 60 * 1000)
  });

  await sb("model_predictions", "POST", {}, {
    model_id: MTF_MODEL_ID,
    asset_id: asset.id,
    predicted_at: iso(),
    direction: decision.action,
    p_t1: decision.pT1,
    p_t2: decision.pT2,
    p_t3: decision.pT3,
    expected_return: decision.expectedValue,
    expected_loss: Math.max(0, 1 - decision.pT1),
    calibration_version: "shadow_uncalibrated",
    feature_snapshot: snapshot
  });

  const rows = await sb("signals", "POST", {}, {
    asset_id: asset.id,
    created_at: iso(),
    horizon: "H4",
    signal: decision.action,
    entry: decision.entry,
    stop_loss: decision.stopLoss,
    target_1: decision.target1,
    target_2: decision.target2,
    target_3: decision.target3,
    p_t1: decision.pT1,
    p_t2: decision.pT2,
    p_t3: decision.pT3,
    expected_value: decision.expectedValue,
    risk_state: "SHADOW",
    data_quality: "HIGH",
    model_id: MTF_MODEL_ID,
    feature_version: FEATURE_VERSION,
    reasons: decision.reasons,
    snapshot,
    immutable: true
  }, { Prefer: "return=representation" });

  const signal = rows?.[0];
  if (!signal?.signal_id) return null;
  state.lastSignalAt.set(cooldownKey, Date.now());
  await maybeOpenPaperTrade(signal, asset, decision);
  await writeSystemEvent("MTF_SHADOW_SIGNAL_CREATED", "info", "multitimeframe_engine", asset.symbol + " " + decision.action, {
    signal_id: signal.signal_id,
    horizon: "H4",
    probability: decision.pT1
  });
  return signal;
}

async function refreshHorizonResearch() {
  try {
    if (!state.assets.length) return;
    let h4Ready = 0, d1Ready = 0, mtfReady = 0;

    const histories = await Promise.all(state.assets.map(async asset => {
      const bars = await sb("ohlcv", "GET", {
        select: "asset_id,bucket_start,open,high,low,close,volume",
        asset_id: "eq." + asset.id,
        timeframe: "eq.1m",
        bucket_start: "gte." + iso(Date.now() - 6 * 60 * 60 * 1000),
        order: "bucket_start.asc",
        limit: "500"
      });
      const d1Rows = await sb("ohlcv", "GET", {
        select: "bucket_start,close",
        asset_id: "eq." + asset.id,
        timeframe: "eq.1m",
        bucket_start: "lte." + iso(Date.now() - 22 * 60 * 60 * 1000),
        order: "bucket_start.desc",
        limit: "1"
      });
      return { asset, bars, d1Anchor: d1Rows?.[0] || null };
    }));

    const now = Date.now();
    for (const { asset, bars, d1Anchor } of histories) {
      const bars4h = bars.filter(x => Date.parse(x.bucket_start) >= now - 4 * 60 * 60 * 1000);
      const covers4h = bars.length && Date.parse(bars[0].bucket_start) <= now - 3.5 * 60 * 60 * 1000;
      if (bars4h.length >= 180 && covers4h) {
        h4Ready++;
        await maybeWriteH4Shadow(asset, bars);
      }
      if (d1Anchor) {
        d1Ready++;
        await maybeWriteD1Shadow(asset, bars, d1Anchor);
        if (bars4h.length >= 180 && covers4h) {
          mtfReady++;
          await maybeWriteMtfShadow(asset, bars, d1Anchor);
        }
      }
    }

    const [h4Evidence, d1Evidence, mtfEvidence] = await Promise.all([
      evaluateHorizonModel(H4_MODEL_ID),
      evaluateHorizonModel(D1_MODEL_ID),
      evaluateHorizonModel(MTF_MODEL_ID)
    ]);
    const h4Signals = await sb("signals", "GET", { select: "signal_id", model_id: "eq." + H4_MODEL_ID, limit: "5000" });
    const d1Signals = await sb("signals", "GET", { select: "signal_id", model_id: "eq." + D1_MODEL_ID, limit: "5000" });
    const mtfSignals = await sb("signals", "GET", { select: "signal_id", model_id: "eq." + MTF_MODEL_ID, limit: "5000" });

    state.horizonResearch.H1 = {
      modelId: MODEL_ID,
      state: productionSignalReady() ? "ACTIONABLE" : (modelSignalReady() ? "STATISTICALLY_READY_RESEARCH_LOCKED" : "VALIDATING"),
      outcomes: state.calibration.sampleCount || 0,
      gate: modelSignalGate()
    };
    state.horizonResearch.H4 = {
      modelId: H4_MODEL_ID,
      state: h4Evidence.gate.ready ? "VALIDATED_SHADOW" : (h4Ready >= 5 ? "SHADOW_COLLECTING" : "DATA_WARMING"),
      readyAssets: h4Ready,
      candidates: h4Signals.length,
      outcomes: h4Evidence.calibration.sampleCount || 0,
      calibration: h4Evidence.calibration,
      validation: h4Evidence.validation,
      gate: h4Evidence.gate
    };
    state.horizonResearch.D1 = {
      modelId: D1_MODEL_ID,
      state: d1Evidence.gate.ready ? "VALIDATED_SHADOW" : (d1Ready >= 5 ? "SHADOW_COLLECTING" : "DATA_WARMING"),
      readyAssets: d1Ready,
      candidates: d1Signals.length,
      outcomes: d1Evidence.calibration.sampleCount || 0,
      calibration: d1Evidence.calibration,
      validation: d1Evidence.validation,
      gate: d1Evidence.gate
    };
    state.horizonResearch.MTF = {
      modelId: MTF_MODEL_ID,
      state: mtfEvidence.gate.ready ? "VALIDATED_SHADOW" : (mtfReady >= 5 ? "SHADOW_COLLECTING" : "DATA_WARMING"),
      readyAssets: mtfReady,
      candidates: mtfSignals.length,
      outcomes: mtfEvidence.calibration.sampleCount || 0,
      calibration: mtfEvidence.calibration,
      validation: mtfEvidence.validation,
      gate: mtfEvidence.gate
    };

    await sb("model_versions", "PATCH", { model_id: "eq." + H4_MODEL_ID }, {
      training_window: {
        type: "shadow_evidence_collection",
        ready_assets: h4Ready,
        candidate_count: h4Signals.length,
        outcome_count: h4Evidence.calibration.sampleCount || 0
      },
      validation_metrics: {
        coverage_ready_assets: h4Ready,
        candidates: h4Signals.length,
        calibration: h4Evidence.calibration,
        validation: h4Evidence.validation,
        signal_gate: h4Evidence.gate
      },
      calibration_method: "shadow_bayesian_outcome_calibration",
      status: state.horizonResearch.H4.state
    });

    await sb("model_versions", "PATCH", { model_id: "eq." + D1_MODEL_ID }, {
      training_window: {
        type: "shadow_evidence_collection",
        ready_assets: d1Ready,
        candidate_count: d1Signals.length,
        outcome_count: d1Evidence.calibration.sampleCount || 0
      },
      validation_metrics: {
        coverage_ready_assets: d1Ready,
        candidates: d1Signals.length,
        calibration: d1Evidence.calibration,
        validation: d1Evidence.validation,
        signal_gate: d1Evidence.gate
      },
      calibration_method: "shadow_bayesian_outcome_calibration",
      status: state.horizonResearch.D1.state
    });

    await sb("model_versions", "PATCH", { model_id: "eq." + MTF_MODEL_ID }, {
      training_window: {
        type: "shadow_evidence_collection",
        ready_assets: mtfReady,
        candidate_count: mtfSignals.length,
        outcome_count: mtfEvidence.calibration.sampleCount || 0
      },
      validation_metrics: {
        coverage_ready_assets: mtfReady,
        candidates: mtfSignals.length,
        calibration: mtfEvidence.calibration,
        validation: mtfEvidence.validation,
        signal_gate: mtfEvidence.gate
      },
      calibration_method: "shadow_bayesian_outcome_calibration",
      status: state.horizonResearch.MTF.state
    });
  } catch (e) {
    recordError(e, "horizon_research");
  }
}

function modelSignalGate() {
  return evaluateSignalReadiness(state.calibration, state.validation);
}

function modelSignalReady() {
  return modelSignalGate().ready;
}

function productionSignalGate() {
  const statistical = modelSignalGate();
  const robustness = evaluateProductionRobustness(state.validation);
  return {
    ready: statistical.ready && robustness.ready,
    statistical,
    robustness,
    failed: [
      ...statistical.failed,
      ...robustness.failed.map(x => "robustness:" + x)
    ]
  };
}

function productionSignalReady() {
  return productionSignalGate().ready;
}

function computeSignal(asset, feat, shadowMode = false) {
  const price = finite(feat.price);
  const spread = finite(feat.spread_bps, 999);
  const fresh = Boolean(feat.data_fresh);
  const quality = Boolean(feat.microstructure_quality);
  const alignment = finite(feat.alignment);
  if (!price || !fresh || !quality || Math.abs(alignment) < 0.25 || spread >= 12) {
    return { action: "NO TRADE", reason: "validation_gate" };
  }

  const direction = alignment > 0 ? "LONG" : "SHORT";
  const volatility = Math.max(0.0015, finite(feat.realized_vol) * 1.5);
  const riskPct = clamp(volatility, 0.0025, 0.0125);
  const sign = direction === "LONG" ? 1 : -1;
  const stop = price * (1 - sign * riskPct);
  const t1 = price * (1 + sign * riskPct);
  const t2 = price * (1 + sign * riskPct * 2);
  const t3 = price * (1 + sign * riskPct * 3);

  if (feat.reason_codes?.includes("NO_MATERIAL_MOVE") || feat.reason_codes?.includes("FLOW_PRICE_CONFLICT")) {
    return { action: "NO TRADE", reason: "feature_conflict_gate" };
  }
  const strength = clamp(Math.abs(alignment), 0, 1);
  const rawProbabilityT1 = clamp(0.50 + strength * 0.32 + Math.max(0, finite(feat.cvd_10m)) * 0.06, 0.51, 0.88);
  const calibrated = !shadowMode && state.calibration.status === "ACTIVE" ? (state.calibration.byDirection[direction] ?? state.calibration.globalProbability) : null;
  const probabilityT1 = calibrated == null ? rawProbabilityT1 : clamp(calibrated, 0.05, 0.60);
  const expectedReturn = probabilityT1 * riskPct - (1 - probabilityT1) * riskPct;
  const riskState = spread < 6 && strength >= 0.45 ? "NORMAL" : "CAUTION";
  const reasons = [
    direction === "LONG" ? "positive_price_flow_alignment" : "negative_price_flow_alignment",
    "fresh_market_data",
    "microstructure_quality_pass",
    spread < 6 ? "tight_spread" : "acceptable_spread"
  ];

  if (rawProbabilityT1 < 0.70 || probabilityT1 < 0.50 || expectedReturn <= 0) {
    return { action: "NO TRADE", reason: "expected_value_gate" };
  }

  return {
    action: direction,
    entry: price,
    stopLoss: stop,
    target1: t1,
    target2: t2,
    target3: t3,
    pT1: probabilityT1,
    pT2: clamp(probabilityT1 * 0.78, 0.35, 0.80),
    pT3: clamp(probabilityT1 * 0.60, 0.25, 0.70),
    expectedValue: expectedReturn,
    riskState,
    reasons,
    horizon: "H1"
  };
}

function classifyRegime(feat) {
  const r = finite(feat.return_5m);
  const rv = finite(feat.realized_vol);
  if (!feat.data_fresh) return { regime: "STALE", probability: 0.99 };
  if (rv > 0.025) return { regime: "HIGH_VOLATILITY", probability: clamp(0.70 + rv, 0, 0.99) };
  if (Math.abs(r) > 0.0015) return { regime: r > 0 ? "UPTREND" : "DOWNTREND", probability: 0.75 };
  return { regime: "RANGE", probability: 0.65 };
}

async function persistFeatures(asset, feat, observedAt) {
  const values = [
    ["return_1m", feat.return_1m],
    ["return_5m", feat.return_5m],
    ["return_15m", feat.return_15m],
    ["realized_vol", feat.realized_vol],
    ["cvd_2m", feat.cvd_2m],
    ["cvd_10m", feat.cvd_10m],
    ["volume_2m_usd", feat.volume_2m_usd],
    ["volume_10m_usd", feat.volume_10m_usd],
    ["orderbook_imbalance", feat.orderbook_imbalance],
    ["spread_bps", feat.spread_bps],
    ["alignment", feat.alignment],
    ["microstructure_quality", feat.microstructure_quality ? 1 : 0]
  ].map(([feature_id, value]) => ({
    asset_id: asset.id,
    feature_id,
    observed_at: observedAt,
    value: value == null ? null : finite(value),
    quality_status: feat.data_fresh && feat.microstructure_quality ? "HIGH" : "LOW",
    source_status: "LIVE",
    feature_version: FEATURE_VERSION,
    metadata: { horizon: feat.horizon || "H1" }
  }));
  await insertRows(
    "feature_values",
    values,
    "asset_id,feature_id,observed_at,feature_version",
    "ignore"
  );
  state.counts.features += values.length;
}

async function persistRegime(asset, feat, observedAt) {
  const regime = classifyRegime(feat);
  await sb("regime_states", "POST", {}, {
    asset_id: asset.id,
    observed_at: observedAt,
    horizon: "H1",
    regime: regime.regime,
    probability: regime.probability,
    method_version: "regime_v1",
    evidence: {
      return_5m: feat.return_5m,
      realized_vol: feat.realized_vol,
      alignment: feat.alignment,
      fresh: feat.data_fresh
    }
  });
  return regime;
}

async function maybeWriteSignal(asset, feat, regime) {
  const shadowMode = !productionSignalReady();
  const decision = computeSignal(asset, feat, shadowMode);
  if (decision.action === "NO TRADE" || state.killSwitch) return null;

  const prior = state.lastSignalAt.get(asset.id) || 0;
  if (Date.now() - prior < SIGNAL_COOLDOWN_MS) return null;

  const snapshot = {
    feature_version: FEATURE_VERSION,
    model_id: MODEL_ID,
    generated_at: iso(),
    signal_mode: shadowMode ? "SHADOW" : "ACTIONABLE",
    asset: asset.symbol,
    feature: feat,
    regime
  };

  const setupRows = await sb("setup_candidates", "POST", {}, {
    asset_id: asset.id,
    detected_at: iso(),
    horizon: decision.horizon,
    direction: decision.action,
    setup_type: "momentum_continuation",
    status: "CANDIDATE",
    evidence: {
      reasons: [...decision.reasons, shadowMode ? "shadow_validation_only" : "validated_model"],
      alignment: feat.alignment,
      spread_bps: feat.spread_bps,
      regime: regime.regime,
      probability_t1: decision.pT1
    },
    feature_snapshot: snapshot,
    expires_at: iso(Date.now() + 15 * 60 * 1000)
  }, { Prefer: "return=representation" });

  await sb("model_predictions", "POST", {}, {
    model_id: MODEL_ID,
    asset_id: asset.id,
    predicted_at: iso(),
    direction: decision.action,
    p_t1: decision.pT1,
    p_t2: decision.pT2,
    p_t3: decision.pT3,
    expected_return: decision.expectedValue,
    expected_loss: Math.max(0, 1 - decision.pT1),
    calibration_version: state.calibration.trainedAt ? (MODEL_ID + "@" + state.calibration.trainedAt) : "uncalibrated",
    feature_snapshot: snapshot
  });

  const signalRows = await sb("signals", "POST", {}, {
    asset_id: asset.id,
    created_at: iso(),
    horizon: decision.horizon,
    signal: decision.action,
    entry: decision.entry,
    stop_loss: decision.stopLoss,
    target_1: decision.target1,
    target_2: decision.target2,
    target_3: decision.target3,
    p_t1: decision.pT1,
    p_t2: decision.pT2,
    p_t3: decision.pT3,
    expected_value: decision.expectedValue,
    risk_state: shadowMode ? "SHADOW" : decision.riskState,
    data_quality: feat.data_fresh && feat.microstructure_quality ? "HIGH" : "LOW",
    model_id: MODEL_ID,
    feature_version: FEATURE_VERSION,
    reasons: decision.reasons,
    snapshot,
    immutable: true
  }, { Prefer: "return=representation" });

  const signal = signalRows?.[0];
  state.lastSignalAt.set(asset.id, Date.now());
  state.counts.signals++;
  state.recentSignals.unshift({
    ...(signal || {}),
    signal_id: signal?.signal_id,
    asset_id: asset.id,
    symbol: asset.symbol,
    action: decision.action,
    probability: decision.pT1,
    entry_price: decision.entry,
    stop_loss: decision.stopLoss,
    target_1: decision.target1,
    status: shadowMode ? "SHADOW" : "VALIDATED"
  });
  state.recentSignals = state.recentSignals.slice(0, 50);
  await writeSystemEvent(shadowMode ? "SHADOW_SIGNAL_CREATED" : "SIGNAL_CREATED", "info", "signal_engine", asset.symbol + " " + decision.action, {
    signal_id: signal?.signal_id,
    probability: decision.pT1,
    expected_value: decision.expectedValue,
    regime: regime.regime
  });
  return { signal, decision, shadowMode };
}

async function maybeOpenPaperTrade(signal, asset, decisionSnapshot) {
  if (!signal?.signal_id) return;
  try {
    const open = await sb("paper_trades", "GET", {
      select: "paper_trade_id,signal_id,status,metadata",
      status: "eq.OPEN",
      limit: "200"
    });
    if (open.some(x => x.metadata?.asset_id === asset.id && (x.metadata?.horizon || "H1") === (decisionSnapshot.horizon || "H1"))) return;

    const notional = 100;
    const qty = notional / finite(decisionSnapshot.entry, 1);
    await sb("paper_trades", "POST", {}, {
      signal_id: signal.signal_id,
      opened_at: iso(),
      side: decisionSnapshot.action,
      entry_price: decisionSnapshot.entry,
      quantity: qty,
      fees: notional * PAPER_FEE_RATE,
      slippage: notional * PAPER_SLIPPAGE_RATE,
      funding_cost: 0,
      realized_pnl: null,
      status: "OPEN",
      metadata: {
        simulation: true,
        asset_id: asset.id,
        symbol: asset.symbol,
        notional_usd: notional,
        horizon: decisionSnapshot.horizon || "H1",
        model_id: decisionSnapshot.modelId || MODEL_ID,
        max_horizon_seconds: decisionSnapshot.maxHorizonSeconds || MAX_HORIZON_SECONDS,
        stop_loss: decisionSnapshot.stopLoss,
        target_1: decisionSnapshot.target1,
        target_2: decisionSnapshot.target2,
        target_3: decisionSnapshot.target3
      }
    });
    state.counts.paperTrades++;
  } catch (e) {
    recordError(e, "paper_trade_open");
  }
}

async function managePaperTrades() {
  const open = await sb("paper_trades", "GET", {
    select: "paper_trade_id,signal_id,side,entry_price,quantity,opened_at,fees,slippage,funding_cost,metadata",
    status: "eq.OPEN",
    limit: "200"
  });
  for (const trade of open) {
    try {
      const assetId = trade.metadata?.asset_id;
      const market = state.market.get(assetId);
      const currentPrice = finite(market?.price);
      if (!currentPrice) continue;

      const meta = trade.metadata || {};
      const openedAtMs = Date.parse(trade.opened_at);
      const ageSeconds = Math.max(0, Math.floor((Date.now() - openedAtMs) / 1000));
      const side = String(trade.side || "").toUpperCase();
      const entry = finite(trade.entry_price);
      const stop = finite(meta.stop_loss);
      const t1 = finite(meta.target_1);
      const t2 = finite(meta.target_2);
      const t3 = finite(meta.target_3);

      const ticks = await sb("market_ticks", "GET", {
        select: "observed_at,price",
        asset_id: "eq." + assetId,
        observed_at: "gte." + trade.opened_at,
        order: "observed_at.asc",
        limit: "5000"
      });
      const path = ticks.map(x => finite(x.price)).filter(x => x > 0);
      if (!path.length) path.push(currentPrice);
      const allPrices = [...path, currentPrice];

      let mfe = 0;
      let mae = 0;
      let t1Hit = false, t2Hit = false, t3Hit = false, slHit = false;
      for (const p of allPrices) {
        const favorable = side === "LONG" ? (p - entry) / entry : (entry - p) / entry;
        const adverse = side === "LONG" ? (entry - p) / entry : (p - entry) / entry;
        mfe = Math.max(mfe, favorable);
        mae = Math.max(mae, adverse);
        if (side === "LONG") {
          t1Hit ||= Boolean(t1 && p >= t1);
          t2Hit ||= Boolean(t2 && p >= t2);
          t3Hit ||= Boolean(t3 && p >= t3);
          slHit ||= Boolean(stop && p <= stop);
        } else if (side === "SHORT") {
          t1Hit ||= Boolean(t1 && p <= t1);
          t2Hit ||= Boolean(t2 && p <= t2);
          t3Hit ||= Boolean(t3 && p <= t3);
          slHit ||= Boolean(stop && p >= stop);
        }
      }

      let outcome = null;
      let exitPrice = null;
      if (t3Hit && slHit) {
        // Conservative bar/tick ambiguity handling: earliest observed threshold wins.
        for (const p of allPrices) {
          const stopFirst = side === "LONG" ? p <= stop : p >= stop;
          const targetFirst = side === "LONG" ? p >= t3 : p <= t3;
          if (stopFirst) { outcome = "STOP_LOSS"; exitPrice = stop; break; }
          if (targetFirst) { outcome = "TARGET_3"; exitPrice = t3; break; }
        }
      } else if (t3Hit) {
        outcome = "TARGET_3"; exitPrice = t3;
      } else if (slHit) {
        outcome = "STOP_LOSS"; exitPrice = stop;
      } else if (ageSeconds >= finite(meta.max_horizon_seconds, MAX_HORIZON_SECONDS)) {
        outcome = "TIMEOUT"; exitPrice = currentPrice;
      }
      if (!outcome) continue;

      const qty = finite(trade.quantity);
      const gross = side === "LONG" ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
      const exitNotional = Math.abs(exitPrice * qty);
      const costs = finite(trade.fees) + finite(trade.slippage) + (exitNotional * PAPER_FEE_RATE) + (exitNotional * PAPER_SLIPPAGE_RATE) + finite(trade.funding_cost);
      const net = gross - costs;

      await sb("paper_trades", "PATCH", {
        paper_trade_id: "eq." + trade.paper_trade_id
      }, {
        closed_at: iso(),
        exit_price: exitPrice,
        realized_pnl: net,
        status: "CLOSED"
      });

      await sb("signal_outcomes", "POST", { on_conflict: "signal_id" }, {
        signal_id: trade.signal_id,
        evaluated_at: iso(),
        outcome,
        t1_hit: t1Hit,
        t2_hit: t2Hit,
        t3_hit: t3Hit,
        sl_hit: slHit,
        exit_price: exitPrice,
        pnl_before_cost: gross,
        pnl_after_cost: net,
        holding_seconds: Math.min(finite(meta.max_horizon_seconds, MAX_HORIZON_SECONDS), ageSeconds),
        mfe,
        mae,
        evaluation_version: "paper_v2"
      }, { Prefer: "resolution=merge-duplicates,return=minimal" });
    } catch (e) {
      recordError(e, "paper_trade:" + trade.paper_trade_id);
    }
  }
}


async function writeDataQuality() {
  const now = Date.now();
  if (now - state.lastQualityWrite < QUALITY_INTERVAL_MS) return;
  state.lastQualityWrite = now;
  const rows = [];
  for (const asset of state.assets) {
    const m = state.market.get(asset.id);
    const nowMs = Date.now();
    const tradeFresh = m?.updatedAt ? (nowMs - m.updatedAt < 20000) : false;
    const bookFresh = m?.bookUpdatedAt ? (nowMs - m.bookUpdatedAt < 20000) : false;
    for (const dataset of ["market_ticks", "orderbook_snapshots", "trades", "funding", "open_interest", "features"]) {
      const fresh = dataset === "orderbook_snapshots" ? bookFresh : dataset === "funding" || dataset === "open_interest" ? true : tradeFresh;
      rows.push({
        asset_id: asset.id,
        exchange: "BYBIT",
        dataset,
        checked_at: iso(),
        status: fresh ? "OK" : "STALE",
        freshness_seconds: dataset === "orderbook_snapshots" && m?.bookUpdatedAt
          ? Math.max(0, (nowMs - m.bookUpdatedAt) / 1000)
          : m?.updatedAt ? Math.max(0, (nowMs - m.updatedAt) / 1000) : null,
        completeness: fresh ? 1 : 0,
        duplicate_rate: 0,
        anomaly_rate: 0,
        details: { simulation_safe: true }
      });
    }
  }
  if (rows.length) await insertRows("data_quality", rows);
}

function applyTicker(asset, ticker) {
  if (!ticker) return;
  const now = Date.now();
  const market = state.market.get(asset.id) || { symbol: asset.symbol };
  market.symbol = asset.symbol;
  market.price = finite(ticker.lastPrice);
  market.change24h = finite(ticker.price24hPcnt);
  market.volume24h = finite(ticker.volume24h);
  market.turnover24h = finite(ticker.turnover24h);
  market.high24h = finite(ticker.highPrice24h);
  market.low24h = finite(ticker.lowPrice24h);
  market.updatedAt = now;
  state.market.set(asset.id, market);
}

async function probeLiveMarket() {
  if (!state.assets.length) throw new Error("No assets available for live market probe");
  const symbols = state.assets.slice(0, 12).map(a => a.symbol + "USDT");
  const relay = await relayJson("snapshot", symbols);
  const trades = Array.isArray(relay.trades) ? relay.trades : [];
  const books = Array.isArray(relay.books) ? relay.books : [];

  const liveTrades = trades.filter(t => finite(t?.price) > 0 && finite(t?.size) > 0);
  const liveBooks = books.filter(b => {
    const bid = Array.isArray(b?.b) && b.b[0] ? finite(b.b[0][0]) : 0;
    const ask = Array.isArray(b?.a) && b.a[0] ? finite(b.a[0][0]) : 0;
    return bid > 0 && ask > 0 && ask >= bid;
  });

  if (!liveTrades.length) throw new Error("Live market probe returned no valid trades");
  if (!liveBooks.length) throw new Error("Live market probe returned no valid orderbooks");

  state.lastTrade = iso();
  state.lastBook = iso();
  state.lastMarketSuccessAt = iso();
  return { trades: liveTrades.length, books: liveBooks.length, generatedAt: relay.generatedAt || null };
}

async function pollMarketData() {
  if (!state.assets.length) return;
  const batchSize = 15;
  const start = state.batchCursor % state.assets.length;
  const batch = Array.from({ length: Math.min(batchSize, state.assets.length) }, (_, i) =>
    state.assets[(start + i) % state.assets.length]
  );
  state.batchCursor = (start + batch.length) % state.assets.length;
  const symbols = batch.map(a => a.symbol + "USDT");
  const started = Date.now();

  try {
    const relay = await relayJson("snapshot", symbols);
    const tickerMap = new Map((relay.tickers || []).map(t => [String(t.symbol).toUpperCase(), t]));
    const bookMap = new Map((relay.books || []).map(b => [String(b.symbol).toUpperCase(), b]));
    const fundingMap = new Map();
    for (const f of relay.funding || []) fundingMap.set(String(f.symbol).toUpperCase(), f);
    const oiMap = new Map();
    for (const x of relay.openInterest || []) oiMap.set(String(x.symbol).toUpperCase(), x);
    const klineMap = new Map((relay.klines || []).map(x => [String(x.symbol).toUpperCase(), x.list]));

    for (const asset of batch) {
      const symbol = asset.symbol.toUpperCase() + "USDT";
      const ticker = tickerMap.get(symbol);
      if (!ticker) continue;
      applyTicker(asset, ticker);

      const observedAt = iso();
      const market = state.market.get(asset.id);
      const tickRow = {
        asset_id: asset.id,
        exchange: "BYBIT",
        observed_at: observedAt,
        price: finite(ticker.lastPrice),
        volume: finite(ticker.volume24h),
        bid: null,
        ask: null,
        spread_bps: null,
        status: "LIVE",
        metadata: { change_24h: ticker.price24hPcnt, turnover_24h: ticker.turnover24h }
      };
      try {
        await insertRows("market_ticks", [tickRow], "asset_id,exchange,observed_at", "ignore");
        state.counts.ticks++;
      } catch (e) {
        recordError(e, "market_tick");
      }

      const rawBook = bookMap.get(symbol);
      if (rawBook) {
        const book = normalizeBook(asset, rawBook);
        if (book.best_bid && book.best_ask && book.best_bid > 0 && book.best_ask > 0) {
          state.lastBook = iso();
        }
        try {
          await insertRows("orderbook_snapshots", [book]);
          state.counts.books++;
          const updatedMarket = state.market.get(asset.id) || {};
          updatedMarket.spreadBps = book.spread_bps;
          updatedMarket.depthUsd = finite(book.bid_depth) + finite(book.ask_depth);
          updatedMarket.bookUpdatedAt = Date.now();
          updatedMarket.bookFresh = true;
          updatedMarket.bid = book.best_bid;
          updatedMarket.ask = book.best_ask;
          state.market.set(asset.id, updatedMarket);
          state.lastBook = iso();
          state.intelligence.onBook(asset.id, {
            bestBid: book.best_bid,
            bestAsk: book.best_ask,
            spreadBps: book.spread_bps,
            imbalance: book.imbalance,
            updatedAt: Date.now()
          });
        } catch (e) {
          recordError(e, "orderbook");
        }
      }

      const trades = (relay.trades || []).filter(t => String(t.symbol).toUpperCase() === symbol);
      if (trades.length) {
        state.lastTrade = iso();
        const tradeRows = trades.map(t => ({
          asset_id: asset.id,
          exchange: "BYBIT",
          trade_id: String(t.execId || t.i || (t.time + ":" + t.price + ":" + t.size + ":" + t.side)),
          observed_at: iso(Number(t.time) || Date.now()),
          price: finite(t.price),
          quantity: finite(t.size),
          side: String(t.side || "").toUpperCase() === "BUY" ? "BUY" : "SELL",
          is_buyer_maker: String(t.side || "").toUpperCase() !== "BUY",
          status: "LIVE",
          metadata: { symbol: asset.symbol, source: "bybit_relay" }
        })).filter(x => x.price > 0 && x.quantity > 0);

        try {
          await insertRows(
            "trades",
            tradeRows,
            "exchange,asset_id,trade_id",
            "ignore"
          );
          state.counts.trades += tradeRows.length;
          for (const t of tradeRows) {
            state.intelligence.onTrade(asset.id, {
              t: Date.parse(t.observed_at),
              price: t.price,
              side: t.side,
              qty: t.quantity
            });
            state.lastTrade = iso();
          }
        } catch (e) {
          recordError(e, "trades");
        }
      }

      const funding = fundingMap.get(symbol);
      if (funding) {
        const row = {
          asset_id: asset.id,
          exchange: "BYBIT",
          observed_at: iso(Number(funding.fundingRateTimestamp) || Date.now()),
          funding_rate: finite(funding.fundingRate),
          next_funding_at: null,
          mark_price: finite(ticker.markPrice || ticker.lastPrice),
          index_price: finite(ticker.indexPrice || ticker.lastPrice),
          status: "LIVE"
        };
        try {
          await insertRows("funding", [row], "asset_id,exchange,observed_at", "ignore");
          state.counts.derivatives++;
          state.lastDeriv = row.observed_at;
        } catch (e) {
          recordError(e, "funding");
        }
      }

      const oi = oiMap.get(symbol);
      if (oi) {
        const row = {
          asset_id: asset.id,
          exchange: "BYBIT",
          observed_at: iso(Number(oi.timestamp) || Date.now()),
          open_interest: finite(oi.openInterest),
          open_interest_usd: finite(oi.openInterest) * finite(ticker.lastPrice),
          status: "LIVE"
        };
        try {
          await insertRows("open_interest", [row], "asset_id,exchange,observed_at", "ignore");
        } catch (e) {
          recordError(e, "open_interest");
        }
      }

      const klines = klineRows(asset, klineMap.get(symbol));
      if (klines.length) {
        try {
          await insertRows("ohlcv", klines, "asset_id,exchange,timeframe,bucket_start", "ignore");
        } catch (e) {
          recordError(e, "ohlcv");
        }
      }
    }

    await writeProviderStatus("OK", null, "market", Date.now() - started);
    state.lastPipelineRun = iso();
    state.lastMarketSuccessAt = iso();
    await runIntelligencePipeline(batch);
  } catch (e) {
    await writeProviderStatus("DEGRADED", String(e?.message || e), "market", Date.now() - started);
    recordError(e, "market_poll");
  }
}

async function runIntelligencePipeline(batch) {
  const observedAt = minuteBucket();
  await readKillSwitch();

  for (const asset of batch) {
    try {
      const feat = state.intelligence.features(asset.id);
      if (!feat?.price) continue;

      await persistFeatures(asset, feat, observedAt);
      const regime = await persistRegime(asset, feat, observedAt);
      const generated = await maybeWriteSignal(asset, feat, regime);

      if (generated?.signal) {
        await maybeOpenPaperTrade(generated.signal, asset, generated.decision);
      }
    } catch (e) {
      recordError(e, "intelligence:" + asset.symbol);
    }
  }

  try {
    await managePaperTrades();
  } catch (e) {
    recordError(e, "paper_trade_manager");
  }

  try {
    await writeDataQuality();
  } catch (e) {
    recordError(e, "data_quality");
  }
}

function publicMarket() {
  return state.assets.map((asset, i) => {
    const m = state.market.get(asset.id) || {};
    return {
      asset_id: asset.id,
      symbol: asset.symbol,
      rank: i + 1,
      eligibilityScore: asset.eligibilityScore,
      price: m.price ?? null,
      change24h: m.change24h ?? null,
      volume24h: m.volume24h ?? null,
      turnover24h: m.turnover24h ?? null,
      high24h: m.high24h ?? null,
      low24h: m.low24h ?? null,
      spreadBps: m.spreadBps ?? null,
      depthUsd: m.depthUsd ?? null,
      updatedAt: m.updatedAt ? iso(m.updatedAt) : null
    };
  });
}

async function dashboardPayload() {
  const providers = await sb("provider_status", "GET", {
    select: "provider,dataset,checked_at,status,latency_ms,last_event_at,error_message",
    limit: "50"
  });
  const paperTrades = await sb("paper_trades", "GET", {
    select: "paper_trade_id,signal_id,opened_at,closed_at,side,entry_price,exit_price,quantity,realized_pnl,status,metadata",
    order: "opened_at.desc",
    limit: "30"
  });
  const dbSignals = await sb("signals", "GET", {
    select: "signal_id,asset_id,created_at,horizon,signal,entry,stop_loss,target_1,target_2,target_3,p_t1,p_t2,p_t3,expected_value,risk_state,data_quality,model_id,feature_version,reasons",
    order: "created_at.desc",
    limit: "30"
  });
  const errors = state.errors.slice(-10);
  return {
    health: {
      status: state.ready ? "ready" : "starting",
      bootStage: state.bootStage,
      startedAt: state.startedAt,
      lastTrade: state.lastTrade,
      lastBook: state.lastBook,
      lastDeriv: state.lastDeriv,
      lastUniverseRefresh: state.lastUniverseRefresh,
      lastPipelineRun: state.lastPipelineRun,
      assets: state.assets.length,
      counts: state.counts,
      killSwitch: state.killSwitch,
      calibration: state.calibration,
      validation: state.validation,
      model: { id: MODEL_ID, featureVersion: FEATURE_VERSION, horizon: "H1" },
      horizonResearch: state.horizonResearch,
      tradingProfile: {
        primary: "SWING_POSITIONAL",
        secondary: "SCALP_CONDITIONAL",
        note: "Current validated model horizon is H1; multi-hour and multi-day swing horizons require separate validation."
      },
      safety: { paperOnly: true, executionEnabled: false, signalReady: productionSignalReady(), statisticalSignalReady: modelSignalReady(), signalGate: productionSignalGate() },
      errors
    },
    market: publicMarket(),
    signals: dbSignals.map(s => ({
      ...s,
      symbol: state.assets.find(a => a.id === s.asset_id)?.symbol || s.asset_id,
      action: s.signal,
      probability: s.p_t1,
      entry_price: s.entry
    })),
    paperTrades: paperTrades.map(t => ({
      ...t,
      asset_id: t.metadata?.asset_id || null,
      symbol: t.metadata?.symbol || state.assets.find(a => a.id === t.metadata?.asset_id)?.symbol || null
    })),
    providers,
    quality: state.assets.map(a => {
      const m = state.market.get(a.id) || {};
      return {
        asset_id: a.id,
        symbol: a.symbol,
        trade_fresh: Boolean(m.updatedAt && Date.now() - m.updatedAt < 20000),
        book_fresh: Boolean(m.bookUpdatedAt && Date.now() - m.bookUpdatedAt < 20000),
        spread_bps: m.spreadBps ?? null
      };
    })
  };
}

function healthReadiness() {
  const now = Date.now();
  const live = Boolean(state.lastTrade && now - Date.parse(state.lastTrade) < 20000);
  const bookLive = Boolean(state.lastBook && now - Date.parse(state.lastBook) < 20000);
  const universeReady = state.assets.length >= 5 && Boolean(state.lastUniverseRefresh);
  const supabaseSuccessMs = state.lastSupabaseSuccessAt ? Date.parse(state.lastSupabaseSuccessAt) : 0;
  const supabaseFailureMs = state.lastSupabaseFailureAt ? Date.parse(state.lastSupabaseFailureAt) : 0;
  const supabaseLive = Boolean(
    supabaseSuccessMs &&
    now - supabaseSuccessMs < 60000 &&
    supabaseSuccessMs >= supabaseFailureMs
  );
  const ready = state.ready && universeReady && live && bookLive && supabaseLive && !state.killSwitch;
  return { ready, live, bookLive, universeReady, supabaseLive };
}

async function healthPayload() {
  const readiness = healthReadiness();
  return {
    ok: readiness.ready,
    status: readiness.ready ? "LIVE" : (state.bootStage === "failed" ? "FAILED" : "STARTING"),
    ready: readiness.ready,
    readiness: {
      universe: readiness.universeReady,
      tradeStream: readiness.live,
      orderbookStream: readiness.bookLive,
      supabase: readiness.supabaseLive
    },
    bootStage: state.bootStage,
    runtime: process.env.RUNTIME_REV || process.env.DEPLOY_REVISION || "unknown",
    source: "BYBIT_PUBLIC_MARKET_DATA",
    paperOnly: true,
    executionEnabled: false,
    signalReady: productionSignalReady(),
    statisticalSignalReady: modelSignalReady(),
    signalGate: productionSignalGate(),
    signalGateReason: productionSignalReady() ? null : productionSignalGate().failed.join(", "),
    killSwitch: state.killSwitch,
    liveTradeStream: readiness.live,
    liveOrderbookStream: readiness.bookLive,
    lastMarketSuccessAt: state.lastMarketSuccessAt,
    lastSupabaseSuccessAt: state.lastSupabaseSuccessAt,
    lastSupabaseFailureAt: state.lastSupabaseFailureAt,
    assets: state.assets.length,
    counts: state.counts,
    lastTrade: state.lastTrade,
    lastBook: state.lastBook,
    lastDeriv: state.lastDeriv,
    lastUniverseRefresh: state.lastUniverseRefresh,
    lastPipelineRun: state.lastPipelineRun,
    calibration: state.calibration,
    validation: state.validation,
    model: { id: MODEL_ID, featureVersion: FEATURE_VERSION, horizon: "H1" },
    horizonResearch: state.horizonResearch,
    tradingProfile: {
      primary: "SWING_POSITIONAL",
      secondary: "SCALP_CONDITIONAL",
      note: "Current validated model horizon is H1; multi-hour and multi-day swing horizons require separate validation."
    },
    errors: state.errors.slice(-10)
  };
}

async function serveStatic(pathname, res) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const safe = normalize(relative).replace(/^\.\.(?:[\\/]|$)/g, "");
  const file = join(PUBLIC_DIR, safe);
  try {
    const body = await readFile(file);
    const ext = extname(file);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };
    res.writeHead(200, {
      "content-type": types[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch {
    jsonReply(res, 404, { error: "not_found" });
  }
}

const preRallyScanner = createPreRallyScanner({ db: sb, log });
const PRE_RALLY_DISCLAIMER = "This is an automated research signal based on market and blockchain data. It is not financial advice, does not guarantee future price movement, and may produce false positives.";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
    if (req.method === "GET" && url.pathname === "/api/health") {
      const payload = await healthPayload();
      return jsonReply(res, payload.ok ? 200 : 503, payload);
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      return jsonReply(res, 200, await dashboardPayload());
    }
    if (req.method === "GET" && url.pathname === "/api/market") {
      return jsonReply(res, 200, { assets: publicMarket() });
    }
    if (req.method === "GET" && url.pathname === "/api/pre-rally") {
      return jsonReply(res, 200, { ...preRallyScanner.state, disclaimer: PRE_RALLY_DISCLAIMER });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/pre-rally/token/")) {
      const tokenAddress = decodeURIComponent(url.pathname.slice("/api/pre-rally/token/".length));
      const token = preRallyScanner.state.tokens.find(x => x.tokenAddress === tokenAddress) || null;
      return jsonReply(res, token ? 200 : 404, token ? { token, disclaimer: PRE_RALLY_DISCLAIMER } : { error: "not_found" });
    }
    if (req.method === "GET" && url.pathname === "/api/signals") {
      return jsonReply(res, 200, { signals: (await dashboardPayload()).signals });
    }
    if (req.method === "GET" && url.pathname === "/api/paper-trades") {
      return jsonReply(res, 200, { paperTrades: (await dashboardPayload()).paperTrades });
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return jsonReply(res, 200, {
        health: await healthPayload(),
        market: publicMarket(),
        recentSignals: state.recentSignals,
        errors: state.errors
      });
    }
    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }
    return jsonReply(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    recordError(e, "http");
    return jsonReply(res, 500, { error: String(e?.message || e) });
  }
});

async function warmResearchState() {
  state.bootStage = "research_warmup";
  const jobs = [
    ["calibration_warmup", () => trainCalibration(true)],
    ["validation_warmup", () => runWalkForwardValidation()],
    ["horizon_warmup", () => refreshHorizonResearch()]
  ];
  for (const [context, job] of jobs) {
    try {
      await job();
    } catch (e) {
      recordError(e, context);
    }
  }
  state.bootStage = "ready";
}

async function boot() {
  state.bootStage = "configuring";
  requireConfigured();
  await readKillSwitch();
  await ensureFeatureRegistry();
  await ensureModel();

  state.bootStage = "universe";
  await refreshUniverse();

  state.bootStage = "live_market";
  const liveProbe = await probeLiveMarket();
  log("live_market_probe_ok", liveProbe);

  const readiness = healthReadiness();
  if (!readiness.universeReady || !readiness.live || !readiness.bookLive || !readiness.supabaseLive) {
    throw new Error(
      "Production readiness gate failed: universe=" + readiness.universeReady +
      ", trade=" + readiness.live +
      ", orderbook=" + readiness.bookLive +
      ", supabase=" + readiness.supabaseLive
    );
  }

  state.ready = true;
  state.bootStage = "ready";
  log("engine_ready", {
    assets: state.assets.length,
    paperOnly: true,
    runtime: process.env.RUNTIME_REV || process.env.DEPLOY_REVISION || "unknown",
    liveTradeStream: readiness.live,
    liveOrderbookStream: readiness.bookLive,
    supabaseLive: readiness.supabaseLive
  });
  await writeSystemEvent("ENGINE_READY", "info", "runtime", "Crypto Intelligence Engine ready", {
    assets: state.assets.length,
    feature_version: FEATURE_VERSION,
    model_id: MODEL_ID
  });
  await writeAudit("engine_ready", "runtime", "crypto-engine", {
    assets: state.assets.length,
    paper_only: true
  });

  setInterval(() => refreshUniverse().catch(e => recordError(e, "universe_interval")), UNIVERSE_REFRESH_MS);
  setInterval(() => refreshHorizonResearch().catch(e => recordError(e, "horizon_interval")), HORIZON_RESEARCH_INTERVAL_MS);
  setInterval(() => trainCalibration(true).catch(e => recordError(e, "training_interval")), TRAIN_INTERVAL_MS);
  setInterval(() => runWalkForwardValidation().catch(e => recordError(e, "validation_interval")), VALIDATION_INTERVAL_MS);
  setInterval(() => pollMarketData().catch(e => recordError(e, "poll_interval")), POLL_MS);
  setImmediate(() => pollMarketData().catch(e => recordError(e, "initial_poll")));

  preRallyScanner.start();
  setImmediate(() => warmResearchState().catch(e => recordError(e, "research_warmup")));
}

server.listen(PORT, HOST, () => {
  log("http_server_listening", { host: HOST, port: PORT });
  boot().catch(async e => {
    state.bootStage = "failed";
    state.ready = false;
    recordError(e, "boot");
    await writeSystemEvent("ENGINE_BOOT_FAILED", "error", "runtime", String(e?.message || e));
  });
});

process.on("SIGTERM", () => {
  log("shutdown", { signal: "SIGTERM" });
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  log("shutdown", { signal: "SIGINT" });
  server.close(() => process.exit(0));
});