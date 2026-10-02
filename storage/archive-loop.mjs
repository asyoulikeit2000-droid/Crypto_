import { createR2Archive, r2Configured } from "./r2.mjs";

const DATASETS = [
  { table: "trades", ageMs: 2 * 60 * 60 * 1000 },
  { table: "orderbook_snapshots", ageMs: 2 * 60 * 60 * 1000 },
  { table: "feature_values", ageMs: 24 * 60 * 60 * 1000 },
  { table: "regime_states", ageMs: 24 * 60 * 60 * 1000 },
  { table: "data_quality", ageMs: 24 * 60 * 60 * 1000 },
  { table: "market_ticks", ageMs: 30 * 60 * 60 * 1000 }
];

function timestampField(row) {
  for (const key of ["created_at","event_time","timestamp","bucket_start","checked_at","updated_at"]) {
    if (row?.[key]) return key;
  }
  return null;
}

export async function archiveOnce(store, log = console.log) {
  if (!r2Configured()) return { status: "SKIPPED", reason: "R2_NOT_CONFIGURED" };
  const archive = createR2Archive();
  await archive.healthcheck();
  const result = [];

  for (const spec of DATASETS) {
    const rows = await store.db(spec.table, "GET", { limit: "10000" });
    const cutoff = Date.now() - spec.ageMs;
    const eligible = rows.filter(row => {
      const field = timestampField(row);
      const ms = field ? Date.parse(row[field]) : NaN;
      return Number.isFinite(ms) && ms < cutoff;
    });
    if (!eligible.length) continue;

    const times = eligible.map(row => {
      const field = timestampField(row);
      return field ? row[field] : null;
    }).filter(Boolean).sort();

    const manifest = await archive.putJsonlGzip({
      dataset: spec.table,
      rows: eligible,
      periodStart: times[0],
      periodEnd: times.at(-1)
    });
    if (!manifest) continue;

    await store.db("archive_manifest", "POST", { on_conflict: "object_key" }, {
      object_key: manifest.objectKey,
      dataset: spec.table,
      symbol: null,
      period_start: times[0] || null,
      period_end: times.at(-1) || null,
      row_count: manifest.rowCount,
      checksum: manifest.checksum,
      archived_at: manifest.archivedAt,
      verified_at: new Date().toISOString()
    }, { Prefer: "resolution=merge-duplicates,return=minimal" });

    for (const row of eligible) {
      const field = timestampField(row);
      if (!field) continue;
      await store.db(spec.table, "DELETE", { [field]: "eq." + row[field] });
    }
    result.push({ dataset: spec.table, archived: eligible.length, objectKey: manifest.objectKey });
    log(JSON.stringify({ message: "r2_archive_complete", dataset: spec.table, rows: eligible.length, objectKey: manifest.objectKey }));
  }
  return { status: "OK", datasets: result };
}

export function startArchiveLoop(store, log = console.log) {
  if (String(process.env.R2_ARCHIVE_ENABLED || "false").toLowerCase() !== "true") {
    return { enabled: false };
  }
  const intervalMs = Math.max(5 * 60 * 1000, Number(process.env.R2_ARCHIVE_INTERVAL_MS || 15 * 60 * 1000));
  const run = () => archiveOnce(store, log).catch(error => {
    console.error(JSON.stringify({ message: "r2_archive_failed", error: String(error?.message || error) }));
  });
  setTimeout(run, 60_000);
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { enabled: true, intervalMs };
}
