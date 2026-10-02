import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL || "";
const authToken = process.env.TURSO_AUTH_TOKEN || "";

export function tursoConfigured() {
  return Boolean(url && authToken);
}

export function createTursoStore() {
  if (!tursoConfigured()) throw new Error("Turso credentials not configured");
  const client = createClient({ url, authToken });

  return {
    client,
    async healthcheck() {
      const result = await client.execute("select 1 as ok");
      return Number(result.rows?.[0]?.ok || 0) === 1;
    },
    async initialize() {
      await client.batch([
        `CREATE TABLE IF NOT EXISTS runtime_health (
          component TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          metadata_json TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS system_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          event_type TEXT NOT NULL,
          severity TEXT NOT NULL,
          component TEXT NOT NULL,
          message TEXT NOT NULL,
          metadata_json TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS model_versions (
          model_id TEXT PRIMARY KEY,
          model_family TEXT NOT NULL,
          target_definition TEXT,
          horizon TEXT,
          feature_version TEXT,
          training_window_json TEXT,
          hyperparameters_json TEXT,
          validation_metrics_json TEXT,
          calibration_method TEXT,
          status TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS signals (
          signal_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          symbol TEXT NOT NULL,
          signal TEXT NOT NULL,
          model_id TEXT NOT NULL,
          horizon TEXT,
          entry REAL,
          stop REAL,
          target_1 REAL,
          target_2 REAL,
          target_3 REAL,
          p_t1 REAL,
          expected_value REAL,
          payload_json TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS idx_signals_symbol_created ON signals(symbol, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_signals_model_created ON signals(model_id, created_at DESC)`,
        `CREATE TABLE IF NOT EXISTS signal_outcomes (
          signal_id TEXT PRIMARY KEY,
          evaluated_at TEXT NOT NULL,
          outcome TEXT,
          t1_hit INTEGER,
          t2_hit INTEGER,
          t3_hit INTEGER,
          mfe REAL,
          mae REAL,
          holding_seconds INTEGER,
          evaluation_version TEXT,
          payload_json TEXT
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
    },
    async markHealth(component, status, metadata = {}) {
      await client.execute({
        sql: `INSERT INTO runtime_health(component,status,checked_at,metadata_json)
              VALUES(?,?,?,?)
              ON CONFLICT(component) DO UPDATE SET status=excluded.status, checked_at=excluded.checked_at, metadata_json=excluded.metadata_json`,
        args: [component, status, new Date().toISOString(), JSON.stringify(metadata)]
      });
    }
  };
}
