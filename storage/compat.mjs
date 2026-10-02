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

  async function list(table) {
    const r = await client.execute({
      sql: "SELECT row_key,payload_json FROM kv_rows WHERE table_name=? ORDER BY updated_at DESC LIMIT 10000",
      args: [table]
    });
    return r.rows.map(x => ({ rowKey: String(x.row_key), row: JSON.parse(String(x.payload_json)) }));
  }

  async function db(table, method="GET", params={}, body, extraHeaders={}) {
    const now = new Date().toISOString();

    if (method === "GET") {
      let rows = (await list(table)).map(x => x.row);
      rows = rows.filter(row => Object.entries(params || {}).every(([k,v]) => matches(row,k,v)));
      if (params.order) {
        const [field,dir] = String(params.order).split(".");
        rows.sort((a,b) => {
          const av=a?.[field], bv=b?.[field];
          if (av === bv) return 0;
          const cmp = av == null ? -1 : bv == null ? 1 : (av > bv ? 1 : -1);
          return dir === "desc" ? -cmp : cmp;
        });
      }
      const off = Math.max(0, Number(params.offset || 0));
      const lim = Math.max(0, Number(params.limit || rows.length));
      return rows.slice(off, off + lim).map(r => project(r, params.select));
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
      const entries = await list(table);
      const out = [];
      for (const item of entries) {
        if (!Object.entries(params || {}).every(([k,v]) => matches(item.row,k,v))) continue;
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
      const entries = await list(table);
      for (const item of entries) {
        if (!Object.entries(params || {}).every(([k,v]) => matches(item.row,k,v))) continue;
        await client.execute({ sql:"DELETE FROM kv_rows WHERE table_name=? AND row_key=?", args:[table,item.rowKey] });
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
