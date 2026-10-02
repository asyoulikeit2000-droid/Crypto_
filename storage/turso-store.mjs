import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";

const url = process.env.TURSO_DATABASE_URL || "";
const authToken = process.env.TURSO_AUTH_TOKEN || "";

export function tursoConfigured() {
  return Boolean(url && (authToken || url.startsWith("file:")));
}

function stableKey(table, row, conflict) {
  const keys = conflict ? String(conflict).split(",").map(x => x.trim()).filter(Boolean) : [];
  const preferred = {
    signals: ["signal_id"],
    signal_outcomes: ["signal_id"],
    model_versions: ["model_id"],
    model_calibrations: ["calibration_id"],
    assets: ["asset_id"],
    feature_registry: ["feature_id"],
    provider_status: ["provider","dataset"],
    kill_switch: ["id"],
    paper_trades: ["paper_trade_id"],
    scanner_tokens: ["token_id"],
    scanner_pairs: ["pair_id"],
    archive_manifest: ["object_key"]
  };
  const use = keys.length ? keys : (preferred[table] || []);
  if (!use.length || use.some(k => row?.[k] === undefined || row?.[k] === null)) return randomUUID();
  const raw = table + "|" + use.map(k => k + "=" + JSON.stringify(row[k])).join("|");
  return createHash("sha256").update(raw).digest("hex");
}

function parseScalar(v) {
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  return String(v).replace(/^"|"$/g, "");
}

function matches(row, key, expr) {
  if (["select","order","limit","offset","on_conflict","Prefer"].includes(key)) return true;
  const s = String(expr ?? "");
  if (s.startsWith("eq.")) return row?.[key] == parseScalar(s.slice(3));
  if (s.startsWith("neq.")) return row?.[key] != parseScalar(s.slice(4));
  if (s.startsWith("gt.")) return row?.[key] > parseScalar(s.slice(3));
  if (s.startsWith("gte.")) return row?.[key] >= parseScalar(s.slice(4));
  if (s.startsWith("lt.")) return row?.[key] < parseScalar(s.slice(3));
  if (s.startsWith("lte.")) return row?.[key] <= parseScalar(s.slice(4));
  if (s === "is.null") return row?.[key] == null;
  if (s === "not.is.null") return row?.[key] != null;
  if (s.startsWith("in.(") && s.endsWith(")")) {
    const vals = s.slice(4,-1).split(",").map(x => parseScalar(x.trim()));
    return vals.some(v => row?.[key] == v);
  }
  return true;
}

const generatedIdFields = {
  universe_snapshots: "snapshot_id",
  universe_members: "member_id",
  signals: "signal_id",
  backtest_runs: "run_id",
  paper_trades: "paper_trade_id",
  model_calibrations: "calibration_id",
  system_events: "event_id",
  audit_logs: "audit_id",
  model_predictions: "prediction_id",
  setup_candidates: "setup_id",
  regime_states: "regime_state_id",
  feature_values: "feature_value_id",
  data_quality: "data_quality_id",
  orderbook_snapshots: "snapshot_id",
  scanner_tokens: "token_id",
  scanner_pairs: "pair_id",
  scanner_market_snapshots: "snapshot_id",
  scanner_evaluations: "evaluation_id"
};

function withGeneratedId(table, row) {
  const field = generatedIdFields[table];
  if (!field || row?.[field]) return { ...row };
  return { ...row, [field]: randomUUID() };
}

function project(row, select) {
  if (!select || select === "*") return row;
  const cols = String(select).split(",").map(x => x.trim()).filter(x => x && !x.includes("("));
  if (!cols.length) return row;
  return Object.fromEntries(cols.map(k => [k, row?.[k]]));
}

export function createTursoCompat() {
  if (!tursoConfigured()) throw new Error("Turso credentials not configured");
  const client = createClient(url.startsWith("file:") ? { url } : { url, authToken });

  async function initialize() {
    await client.batch([
      `CREATE TABLE IF NOT EXISTS kv_rows (
        table_name TEXT NOT NULL,
        row_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(table_name,row_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_kv_rows_table_updated ON kv_rows(table_name,updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_kv_rows_asset_time ON kv_rows(
        table_name,
        json_extract(payload_json,'$.asset_id'),
        json_extract(payload_json,'$.timeframe'),
        json_extract(payload_json,'$.bucket_start')
      )`,
      `CREATE INDEX IF NOT EXISTS idx_kv_rows_model_created ON kv_rows(
        table_name,
        json_extract(payload_json,'$.model_id'),
        json_extract(payload_json,'$.created_at')
      )`,
      `CREATE INDEX IF NOT EXISTS idx_kv_rows_provider_dataset ON kv_rows(
        table_name,
        json_extract(payload_json,'$.provider'),
        json_extract(payload_json,'$.dataset')
      )`,
      `CREATE TABLE IF NOT EXISTS runtime_health (
        component TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        metadata_json TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS archive_manifest (
        object_key TEXT PRIMARY KEY,
        dataset TEXT NOT NULL,
        symbol TEXT,
        period_start TEXT,
        period_end TEXT,
        row_count INTEGER,
        checksum TEXT,
        archived_at TEXT NOT NULL,
        verified_at TEXT
      )`
    ], "write");
  }

  async function healthcheck() {
    const r = await client.execute("select 1 as ok");
    return Number(r.rows?.[0]?.ok || 0) === 1;
  }

  function sqlValue(v) {
    const parsed = parseScalar(v);
    if (parsed === true) return 1;
    if (parsed === false) return 0;
    return parsed;
  }

  function jsonExpr(field) {
    if (!/^[A-Za-z0-9_]+$/.test(field)) throw new Error("Unsupported storage field " + field);
    return "json_extract(payload_json,'$." + field + "')";
  }

  function buildQuery(table, params = {}) {
    const where = ["table_name=?"];
    const args = [table];
    for (const [key, raw] of Object.entries(params || {})) {
      if (["select","order","limit","offset","on_conflict","Prefer"].includes(key)) continue;
      const expr = jsonExpr(key);
      const s = String(raw ?? "");
      if (s.startsWith("eq.")) { where.push(expr + " = ?"); args.push(sqlValue(s.slice(3))); continue; }
      if (s.startsWith("neq.")) { where.push(expr + " != ?"); args.push(sqlValue(s.slice(4))); continue; }
      if (s.startsWith("gt.")) { where.push(expr + " > ?"); args.push(sqlValue(s.slice(3))); continue; }
      if (s.startsWith("gte.")) { where.push(expr + " >= ?"); args.push(sqlValue(s.slice(4))); continue; }
      if (s.startsWith("lt.")) { where.push(expr + " < ?"); args.push(sqlValue(s.slice(3))); continue; }
      if (s.startsWith("lte.")) { where.push(expr + " <= ?"); args.push(sqlValue(s.slice(4))); continue; }
      if (s === "is.null") { where.push(expr + " IS NULL"); continue; }
      if (s === "not.is.null") { where.push(expr + " IS NOT NULL"); continue; }
      if (s.startsWith("in.(") && s.endsWith(")")) {
        const vals = s.slice(4,-1).split(",").map(x => sqlValue(x.trim()));
        if (!vals.length) { where.push("1=0"); continue; }
        where.push(expr + " IN (" + vals.map(() => "?").join(",") + ")");
        args.push(...vals);
        continue;
      }
      throw new Error("Unsupported storage filter " + key + "=" + s);
    }

    let orderSql = "updated_at DESC";
    if (params.order) {
      const [field, dirRaw] = String(params.order).split(".");
      const dir = String(dirRaw || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
      orderSql = jsonExpr(field) + " " + dir;
    }
    const limit = Math.max(0, Math.min(50000, Number(params.limit ?? 10000)));
    const offset = Math.max(0, Number(params.offset || 0));
    const sql = "SELECT row_key,payload_json FROM kv_rows WHERE " + where.join(" AND ") +
      " ORDER BY " + orderSql + " LIMIT ? OFFSET ?";
    return { sql, args: [...args, limit, offset] };
  }

  async function queryEntries(table, params = {}) {
    const q = buildQuery(table, params);
    const r = await client.execute(q);
    return r.rows.map(x => ({ rowKey: String(x.row_key), row: JSON.parse(String(x.payload_json)) }));
  }

  async function db(table, method="GET", params={}, body, extraHeaders={}) {
    const now = new Date().toISOString();

    if (method === "GET") {
      const entries = await queryEntries(table, params);
      return entries.map(x => project(x.row, params.select));
    }

    if (method === "POST") {
      const rows = (Array.isArray(body) ? body : [body]).filter(Boolean);
      const conflict = params?.on_conflict || null;
      const prefer = String(extraHeaders?.Prefer || "");
      const returning = prefer.includes("return=representation");
      const merge = prefer.includes("merge-duplicates");
      const ignore = prefer.includes("ignore-duplicates");
      const prepared = rows.map(input => {
        const next = withGeneratedId(table, input);
        return { next, key: stableKey(table, next, conflict) };
      });

      if (!returning && !merge && prepared.length > 1) {
        await client.batch(prepared.map(({next,key}) => ({
          sql: ignore
            ? "INSERT OR IGNORE INTO kv_rows(table_name,row_key,created_at,updated_at,payload_json) VALUES(?,?,?,?,?)"
            : "INSERT INTO kv_rows(table_name,row_key,created_at,updated_at,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(table_name,row_key) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json",
          args: [table,key,now,now,JSON.stringify(next)]
        })), "write");
        return [];
      }

      const out = [];
      for (const item of prepared) {
        let next = item.next;
        const key = item.key;
        if (merge) {
          const existing = await client.execute({
            sql: "SELECT payload_json FROM kv_rows WHERE table_name=? AND row_key=? LIMIT 1",
            args: [table,key]
          });
          if (existing.rows.length) next = { ...JSON.parse(String(existing.rows[0].payload_json)), ...next };
        }
        const result = await client.execute({
          sql: ignore
            ? "INSERT OR IGNORE INTO kv_rows(table_name,row_key,created_at,updated_at,payload_json) VALUES(?,?,?,?,?)"
            : "INSERT INTO kv_rows(table_name,row_key,created_at,updated_at,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(table_name,row_key) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json",
          args: [table,key,now,now,JSON.stringify(next)]
        });
        if (returning && (!ignore || Number(result.rowsAffected || 0) > 0)) out.push(next);
      }
      return returning ? out : [];
    }

    if (method === "PATCH") {
      const entries = await queryEntries(table, { ...params, limit: params.limit || 10000 });
      const out = [];
      for (const item of entries) {
        const next = { ...item.row, ...(body || {}) };
        await client.execute({
          sql: "UPDATE kv_rows SET updated_at=?,payload_json=? WHERE table_name=? AND row_key=?",
          args: [now,JSON.stringify(next),table,item.rowKey]
        });
        out.push(next);
      }
      return String(extraHeaders?.Prefer || "").includes("return=representation") ? out : [];
    }

    if (method === "DELETE") {
      const entries = await queryEntries(table, { ...params, limit: params.limit || 10000 });
      if (entries.length) {
        await client.batch(entries.map(item => ({
          sql: "DELETE FROM kv_rows WHERE table_name=? AND row_key=?",
          args: [table,item.rowKey]
        })), "write");
      }
      return [];
    }

    throw new Error("Unsupported storage method " + method);
  }

  async function markHealth(component,status,metadata={}) {
    await client.execute({
      sql: `INSERT INTO runtime_health(component,status,checked_at,metadata_json)
            VALUES(?,?,?,?)
            ON CONFLICT(component) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,metadata_json=excluded.metadata_json`,
      args: [component,status,new Date().toISOString(),JSON.stringify(metadata)]
    });
  }

  return { client, initialize, healthcheck, db, markHealth, backend: "turso" };
}
