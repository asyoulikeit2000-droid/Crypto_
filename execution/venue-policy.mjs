const SUPPORTED = new Set(["BINANCE", "BYBIT", "OKX"]);

export function normalizeExchange(value) {
  return String(value || "").trim().toUpperCase();
}

export function evaluateVenueAlignment({ executionExchange, marketExchange, bookExchange, crossVenueAllowed = false } = {}) {
  const execution = normalizeExchange(executionExchange);
  const market = normalizeExchange(marketExchange);
  const book = normalizeExchange(bookExchange);
  const failed = [];

  if (!SUPPORTED.has(execution)) failed.push("executionVenueUnsupported");
  if (!SUPPORTED.has(market)) failed.push("marketVenueUnsupported");
  if (!SUPPORTED.has(book)) failed.push("bookVenueUnsupported");

  if (!crossVenueAllowed) {
    if (market !== execution) failed.push("marketVenueMismatch");
    if (book !== execution) failed.push("bookVenueMismatch");
  }

  return { allowed: failed.length === 0, failed, execution, market, book };
}

export function makeClientOrderId(prefix = "ce", now = Date.now(), nonce = 0) {
  const ts = Math.max(0, Math.floor(Number(now) || 0)).toString(36);
  const n = Math.max(0, Math.floor(Number(nonce) || 0)).toString(36);
  return `${String(prefix).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8)}-${ts}-${n}`.slice(0, 32);
}
