const BYBIT = "https://api.bybit.com";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

async function getJson(path) {
  const r = await fetch(BYBIT + path, { headers: { "user-agent": "crypto-intelligence-cloudflare-relay/1.0" } });
  const text = await r.text();
  if (!r.ok) throw new Error("Bybit " + r.status + " " + text.slice(0, 300));
  const data = JSON.parse(text);
  if (Number(data?.retCode || 0) !== 0) throw new Error("Bybit retCode " + data.retCode + " " + String(data.retMsg || ""));
  return data;
}

async function archiveSnapshot(bucket, payload) {
  const d = new Date(payload.generatedAt || Date.now());
  if (d.getUTCSeconds() >= 5) return;
  const pad = n => String(n).padStart(2, "0");
  const key =
    "raw-market/bybit/" +
    d.getUTCFullYear() + "/" + pad(d.getUTCMonth() + 1) + "/" + pad(d.getUTCDate()) + "/" +
    pad(d.getUTCHours()) + "/" + pad(d.getUTCMinutes()) + ".json";
  await bucket.put(key, JSON.stringify(payload), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      source: "BYBIT_VIA_CLOUDFLARE",
      generated_at: String(payload.generatedAt || ""),
      ticker_count: String(payload.tickers?.length || 0)
    }
  });
}

async function safe(path, fallback, label, errors) {
  try { return await getJson(path); }
  catch (e) { errors.push({ label, error: String(e?.message || e).slice(0, 240) }); return fallback; }
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
      const url = new URL(request.url);
      if (url.pathname === "/health") return json({ ok: true, service: "crypto-market-relay", source: "CLOUDFLARE_WORKERS" });
      const mode = url.searchParams.get("mode") || "snapshot";
      const symbols = (url.searchParams.get("symbols") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);

      if (mode === "bootstrap") {
        const [info, tickers] = await Promise.all([
          getJson("/v5/market/instruments-info?category=linear&status=Trading&limit=1000"),
          getJson("/v5/market/tickers?category=linear")
        ]);
        return json({ ok: true, mode, source: "BYBIT_VIA_CLOUDFLARE", generatedAt: new Date().toISOString(), info: info.result?.list || [], tickers: tickers.result?.list || [] });
      }

      if (!symbols.length) return json({ ok: false, error: "symbols_required" }, 400);
      const errors = [];
      const tickersResponse = await getJson("/v5/market/tickers?category=linear");
      const tickerMap = new Map((tickersResponse.result?.list || []).map(x => [String(x.symbol || "").toUpperCase(), x]));
      const tickers = symbols.map(s => tickerMap.get(s)).filter(Boolean);

      const [books, tradesBySymbol, fundingBySymbol, oiBySymbol, klines] = await Promise.all([
        Promise.all(symbols.map(async s => {
          const j = await safe("/v5/market/orderbook?category=linear&symbol=" + encodeURIComponent(s) + "&limit=5", { result: { s, b: [], a: [], ts: Date.now() } }, "orderbook:" + s, errors);
          return { symbol: s, ...(j.result || {}) };
        })),
        Promise.all(symbols.map(async s => {
          const j = await safe("/v5/market/recent-trade?category=linear&symbol=" + encodeURIComponent(s) + "&limit=10", { result: { list: [] } }, "trades:" + s, errors);
          return (j.result?.list || []).map(t => ({ ...t, symbol: s }));
        })),
        Promise.all(symbols.map(async s => {
          const j = await safe("/v5/market/funding/history?category=linear&symbol=" + encodeURIComponent(s) + "&limit=1", { result: { list: [] } }, "funding:" + s, errors);
          return (j.result?.list || []).map(x => ({ ...x, symbol: s }));
        })),
        Promise.all(symbols.map(async s => {
          const j = await safe("/v5/market/open-interest?category=linear&symbol=" + encodeURIComponent(s) + "&intervalTime=5min&limit=1", { result: { list: [] } }, "open_interest:" + s, errors);
          return (j.result?.list || []).map(x => ({ ...x, symbol: s }));
        })),
        Promise.all(symbols.map(async s => {
          const j = await safe("/v5/market/kline?category=linear&symbol=" + encodeURIComponent(s) + "&interval=1&limit=3", { result: { list: [] } }, "kline:" + s, errors);
          return { symbol: s, list: j.result?.list || [] };
        }))
      ]);

      const payload = {
        ok: true, mode, source: "BYBIT_VIA_CLOUDFLARE", generatedAt: new Date().toISOString(),
        tickers, books, trades: tradesBySymbol.flat(), funding: fundingBySymbol.flat(),
        openInterest: oiBySymbol.flat(), klines, diagnostics: { errors }
      };
      if (env.ARCHIVE) ctx.waitUntil(archiveSnapshot(env.ARCHIVE, payload));
      return json(payload);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e).slice(0, 500) }, 502);
    }
  }
};
