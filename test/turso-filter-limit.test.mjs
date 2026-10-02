import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("Turso filters before applying row limit", async (t) => {
  process.env.TURSO_DATABASE_URL = pathToFileURL(join(tmpdir(), "crypto-limit-" + process.pid + "-" + Date.now() + ".db")).href;
  process.env.TURSO_AUTH_TOKEN = "";
  const mod = await import("../storage/turso-store.mjs?limit-test=" + Date.now());
  const store = mod.createTursoCompat();
  t.after(() => store.client.close?.());
  await store.initialize();

  await store.client.execute(`
    WITH RECURSIVE
      a(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM a WHERE x<100),
      b(y) AS (SELECT 0 UNION ALL SELECT y+1 FROM b WHERE y<100)
    INSERT INTO kv_rows(table_name,row_key,created_at,updated_at,payload_json)
    SELECT
      'ohlcv',
      'k' || (x*101+y+1),
      datetime('now'),
      datetime('now','-' || (x*101+y+1) || ' seconds'),
      json_object(
        'asset_id', CASE WHEN (x*101+y+1)=10201 THEN 'bybit:needle' ELSE 'bybit:other' END,
        'timeframe','1m',
        'bucket_start',datetime('now','-' || (x*101+y+1) || ' seconds'),
        'close',1
      )
    FROM a CROSS JOIN b
    WHERE (x*101+y+1) <= 10201
  `);

  const rows = await store.db("ohlcv","GET",{
    asset_id:"eq.bybit:needle",
    timeframe:"eq.1m",
    order:"bucket_start.asc",
    limit:"1"
  });
  assert.equal(rows.length,1);
  assert.equal(rows[0].asset_id,"bybit:needle");
});
