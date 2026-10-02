const RULES = [
  { table: "trades", ageMs: 4 * 60 * 60 * 1000 },
  { table: "orderbook_snapshots", ageMs: 4 * 60 * 60 * 1000 },
  { table: "feature_values", ageMs: 48 * 60 * 60 * 1000 },
  { table: "regime_states", ageMs: 48 * 60 * 60 * 1000 },
  { table: "data_quality", ageMs: 48 * 60 * 60 * 1000 },
  { table: "market_ticks", ageMs: 48 * 60 * 60 * 1000 },
  { table: "ohlcv", ageMs: 14 * 24 * 60 * 60 * 1000 },
  { table: "scanner_market_snapshots", ageMs: 7 * 24 * 60 * 60 * 1000 },
  { table: "scanner_evaluations", ageMs: 30 * 24 * 60 * 60 * 1000 }
];

function timestampField(row) {
  for (const key of ["observed_at","created_at","detected_at","evaluated_at","bucket_start","checked_at","updated_at"]) {
    if (row?.[key]) return key;
  }
  return null;
}

function deleteParams(table, row) {
  const fields = {
    trades: ["exchange","asset_id","trade_id"],
    orderbook_snapshots: ["snapshot_id"],
    feature_values: ["feature_value_id"],
    regime_states: ["regime_state_id"],
    data_quality: ["data_quality_id"],
    market_ticks: ["exchange","asset_id","observed_at"],
    ohlcv: ["exchange","asset_id","timeframe","bucket_start"],
    scanner_market_snapshots: ["snapshot_id"],
    scanner_evaluations: ["evaluation_id"]
  }[table] || [];
  if (!fields.length || fields.some(k => row?.[k] === undefined || row?.[k] === null)) return null;
  return Object.fromEntries(fields.map(k => [k, "eq." + row[k]]));
}

export async function retentionOnce(store, log = console.log) {
  const result = [];
  for (const rule of RULES) {
    const rows = await store.db(rule.table, "GET", { limit: "10000" });
    const cutoff = Date.now() - rule.ageMs;
    let deleted = 0;
    for (const row of rows) {
      const field = timestampField(row);
      const ms = field ? Date.parse(row[field]) : NaN;
      if (!Number.isFinite(ms) || ms >= cutoff) continue;
      const params = deleteParams(rule.table, row);
      if (!params) continue;
      await store.db(rule.table, "DELETE", params);
      deleted++;
    }
    if (deleted) {
      result.push({ table: rule.table, deleted });
      log("turso_retention", { table: rule.table, deleted });
    }
  }
  return { status: "OK", tables: result };
}

export function startRetentionLoop(store, log = console.log) {
  const enabled = String(process.env.TURSO_RETENTION_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) return { enabled: false };
  const intervalMs = Math.max(30 * 60 * 1000, Number(process.env.TURSO_RETENTION_INTERVAL_MS || 60 * 60 * 1000));
  const run = () => retentionOnce(store, log).catch(error => {
    console.error(JSON.stringify({ message: "turso_retention_failed", error: String(error?.message || error) }));
  });
  setTimeout(run, 10 * 60 * 1000).unref?.();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { enabled: true, intervalMs };
}
