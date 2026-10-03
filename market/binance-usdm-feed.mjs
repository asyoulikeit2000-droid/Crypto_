const PUBLIC_BASE = "wss://fstream.binance.com/public/stream?streams=";
const MARKET_BASE = "wss://fstream.binance.com/market/stream?streams=";
const REST_BASE = "https://fapi.binance.com";

function finite(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function symbolKey(v) {
  return String(v || "").trim().toUpperCase();
}

function lowerSymbol(v) {
  return symbolKey(v).toLowerCase();
}

function parseMessage(raw) {
  try {
    const text = typeof raw === "string" ? raw : raw?.data ?? raw;
    const parsed = typeof text === "string" ? JSON.parse(text) : JSON.parse(String(text));
    return parsed?.data ?? parsed;
  } catch {
    return null;
  }
}

export function publicStreams(symbols = []) {
  return [...new Set(symbols.map(lowerSymbol).filter(Boolean))]
    .flatMap(s => [`${s}@depth20@100ms`, `${s}@bookTicker`]);
}

export function marketStreams(symbols = []) {
  return [...new Set(symbols.map(lowerSymbol).filter(Boolean))]
    .flatMap(s => [`${s}@aggTrade`, `${s}@markPrice@1s`]);
}

export function combinedUrl(base, streams) {
  if (!streams?.length) throw new Error("streams required");
  return base + streams.join("/");
}

export function normalizeAggTrade(d = {}) {
  const symbol = symbolKey(d.s);
  const price = finite(d.p);
  const qty = finite(d.q);
  const t = finite(d.T ?? d.E, Date.now());
  if (!symbol || !(price > 0) || !(qty > 0)) return null;
  return {
    type:"trade",
    exchange:"BINANCE",
    symbol,
    t,
    price,
    qty,
    side:d.m === true ? "SELL" : "BUY",
    makerBuyer:Boolean(d.m),
    aggregateTradeId:d.a ?? null
  };
}

export function normalizeBookTicker(d = {}) {
  const symbol = symbolKey(d.s);
  const bid = finite(d.b);
  const ask = finite(d.a);
  const bidQty = finite(d.B, 0);
  const askQty = finite(d.A, 0);
  const t = finite(d.E ?? d.T, Date.now());
  if (!symbol || !(bid > 0) || !(ask > 0) || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return {
    type:"bookTicker",
    exchange:"BINANCE",
    symbol,
    t,
    bid,
    ask,
    bidQty,
    askQty,
    spreadBps: mid > 0 ? (ask - bid) / mid * 10_000 : null
  };
}

export function normalizeDepth(d = {}) {
  const symbol = symbolKey(d.s);
  const bids = Array.isArray(d.b) ? d.b : [];
  const asks = Array.isArray(d.a) ? d.a : [];
  const t = finite(d.E ?? d.T, Date.now());
  if (!symbol || !bids.length || !asks.length) return null;

  const bidRows = bids.map(x => [finite(x?.[0]), finite(x?.[1],0)]).filter(x => x[0] > 0 && x[1] >= 0);
  const askRows = asks.map(x => [finite(x?.[0]), finite(x?.[1],0)]).filter(x => x[0] > 0 && x[1] >= 0);
  if (!bidRows.length || !askRows.length) return null;

  const bidDepthUsd = bidRows.reduce((s,[p,q])=>s+p*q,0);
  const askDepthUsd = askRows.reduce((s,[p,q])=>s+p*q,0);
  const denom = bidDepthUsd + askDepthUsd;
  const bestBid = bidRows[0][0];
  const bestAsk = askRows[0][0];
  const mid = (bestBid + bestAsk) / 2;

  return {
    type:"depth",
    exchange:"BINANCE",
    symbol,
    t,
    bids:bidRows,
    asks:askRows,
    bestBid,
    bestAsk,
    bidDepthUsd,
    askDepthUsd,
    depthUsd:denom,
    imbalance:denom > 0 ? (bidDepthUsd - askDepthUsd) / denom : 0,
    spreadBps:mid > 0 ? (bestAsk - bestBid) / mid * 10_000 : null,
    updateId:d.u ?? null,
    previousUpdateId:d.pu ?? null
  };
}

export function normalizeMarkPrice(d = {}) {
  const symbol = symbolKey(d.s);
  const markPrice = finite(d.p);
  const fundingRate = finite(d.r, 0);
  const nextFundingTime = finite(d.T);
  const t = finite(d.E, Date.now());
  if (!symbol || !(markPrice > 0)) return null;
  return {
    type:"mark",
    exchange:"BINANCE",
    symbol,
    t,
    markPrice,
    indexPrice:finite(d.i),
    fundingRate,
    nextFundingTime,
    movingAverageMarkPrice:finite(d.ap)
  };
}

export function createBinanceUsdmFeed({
  symbols = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT"],
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  onTrade = () => {},
  onBook = () => {},
  onMark = () => {},
  onOpenInterest = () => {},
  onStatus = () => {},
  oiPollMs = 30_000,
  staleMs = 10_000,
  reconnectBaseMs = 1_000,
  reconnectMaxMs = 30_000,
  maxConnectionAgeMs = 23 * 60 * 60 * 1000 + 50 * 60 * 1000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setRepeater = setInterval,
  clearRepeater = clearInterval
} = {}) {
  if (typeof WebSocketImpl !== "function") throw new Error("WebSocket implementation unavailable");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation unavailable");

  const wanted = [...new Set(symbols.map(symbolKey).filter(Boolean))];
  const latest = new Map();
  const sockets = new Map();
  let reconnectAttempt = 0;
  let stopped = true;
  let oiTimer = null;
  let staleTimer = null;
  let ageTimer = null;
  let reconnectTimer = null;
  const connectWatchdogs = new Map();

  function updateStatus(symbol, field, t = Date.now()) {
    const s = latest.get(symbol) || { symbol };
    s[field] = t;
    latest.set(symbol,s);
  }

  function emitStatus(extra = {}) {
    const now = Date.now();
    const symbolsStatus = {};
    for (const symbol of wanted) {
      const s = latest.get(symbol) || {};
      const lastTrade = finite(s.lastTradeAt, 0);
      const lastBook = finite(s.lastBookAt, 0);
      const lastMark = finite(s.lastMarkAt, 0);
      symbolsStatus[symbol] = {
        lastTradeAt:lastTrade || null,
        lastBookAt:lastBook || null,
        lastMarkAt:lastMark || null,
        tradeFresh:Boolean(lastTrade && now-lastTrade <= staleMs),
        bookFresh:Boolean(lastBook && now-lastBook <= staleMs),
        markFresh:Boolean(lastMark && now-lastMark <= Math.max(staleMs,5_000))
      };
    }
    const healthy = Object.values(symbolsStatus).length > 0 &&
      Object.values(symbolsStatus).every(x => x.tradeFresh && x.bookFresh && x.markFresh);
    onStatus({
      exchange:"BINANCE",
      connected:[...sockets.values()].filter(x=>x?.readyState===1).length,
      expectedConnections:2,
      healthy,
      symbols:symbolsStatus,
      at:now,
      ...extra
    });
  }

  function processPublic(raw) {
    const d=parseMessage(raw);
    if (!d) return;
    if (d.e === "aggTrade") {
      const row=normalizeAggTrade(d);
      if (row) {
        updateStatus(row.symbol,"lastTradeAt",row.t);
        onTrade(row);
      }
      return;
    }
    if (d.e === "depthUpdate" || (Array.isArray(d.b) && Array.isArray(d.a) && d.s)) {
      const row=normalizeDepth(d);
      if (row) {
        updateStatus(row.symbol,"lastBookAt",row.t);
        onBook(row);
      }
      return;
    }
    if (d.s && d.b != null && d.a != null) {
      const row=normalizeBookTicker(d);
      if (row) onBook(row);
    }
  }

  function processMarket(raw) {
    const d=parseMessage(raw);
    if (!d) return;
    if (d.e === "aggTrade") {
      const row=normalizeAggTrade(d);
      if (row) {
        updateStatus(row.symbol,"lastTradeAt",row.t);
        onTrade(row);
      }
      return;
    }
    if (d.e === "markPriceUpdate" || (d.s && d.p != null && d.r != null)) {
      const row=normalizeMarkPrice(d);
      if (row) {
        updateStatus(row.symbol,"lastMarkAt",row.t);
        onMark(row);
      }
    }
  }

  function closeSockets(reason = "restart") {
    for (const timer of connectWatchdogs.values()) {
      try { clearTimer(timer); } catch {}
    }
    connectWatchdogs.clear();
    for (const ws of sockets.values()) {
      try { ws.close(1000,reason); } catch {}
    }
    sockets.clear();
  }

  function scheduleReconnect(reason) {
    if (stopped || reconnectTimer) return;
    closeSockets("reconnect");
    const delay=Math.min(reconnectMaxMs,reconnectBaseMs * Math.max(1,2 ** reconnectAttempt));
    reconnectAttempt=Math.min(10,reconnectAttempt+1);
    onStatus({exchange:"BINANCE",healthy:false,reconnecting:true,reason,delayMs:delay,at:Date.now()});
    reconnectTimer=setTimer(()=>{
      reconnectTimer=null;
      connect();
    },delay);
  }

  function attach(kind,url,handler) {
    let ws;
    try {
      ws=new WebSocketImpl(url);
    } catch (error) {
      onStatus({
        exchange:"BINANCE",
        healthy:false,
        event:kind+"ConstructorError",
        error:String(error?.message||error),
        url,
        at:Date.now()
      });
      scheduleReconnect(kind+"ConstructorError");
      return null;
    }
    sockets.set(kind,ws);

    const watchdog=setTimer(()=>{
      if (ws.readyState !== 1) {
        onStatus({
          exchange:"BINANCE",
          healthy:false,
          event:kind+"ConnectTimeout",
          readyState:ws.readyState,
          url,
          at:Date.now()
        });
        scheduleReconnect(kind+"ConnectTimeout");
      }
    },10_000);
    connectWatchdogs.set(kind,watchdog);

    ws.addEventListener?.("open",()=>{
      const timer=connectWatchdogs.get(kind);
      if (timer) clearTimer(timer);
      connectWatchdogs.delete(kind);
      reconnectAttempt=0;
      emitStatus({event:kind+"Open",url});
    });
    ws.addEventListener?.("message",handler);
    ws.addEventListener?.("error",event=>{
      onStatus({
        exchange:"BINANCE",
        healthy:false,
        event:kind+"Error",
        error:String(event?.message||event?.error?.message||"websocket error"),
        readyState:ws.readyState,
        url,
        at:Date.now()
      });
      scheduleReconnect(kind+"Error");
    });
    ws.addEventListener?.("close",event=> {
      onStatus({
        exchange:"BINANCE",
        healthy:false,
        event:kind+"Close",
        code:event?.code ?? null,
        reason:event?.reason ?? null,
        readyState:ws.readyState,
        url,
        at:Date.now()
      });
      if (!stopped) scheduleReconnect(kind+"Close");
    });
    return ws;
  }

  function connect() {
    if (stopped) return;
    closeSockets("replace");
    attach("public",combinedUrl(PUBLIC_BASE,publicStreams(wanted)),e=>processPublic(e));
    attach("market",combinedUrl(MARKET_BASE,marketStreams(wanted)),e=>processMarket(e));
    if (ageTimer) clearTimer(ageTimer);
    ageTimer=setTimer(()=>scheduleReconnect("maxConnectionAge"),maxConnectionAgeMs);
  }

  async function pollOpenInterest() {
    await Promise.all(wanted.map(async symbol=>{
      try {
        const res=await fetchImpl(`${REST_BASE}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`);
        if (!res?.ok) throw new Error("openInterest HTTP "+(res?.status ?? "unknown"));
        const d=await res.json();
        const openInterest=finite(d?.openInterest);
        const t=finite(d?.time,Date.now());
        if (openInterest != null) {
          onOpenInterest({
            type:"openInterest",
            exchange:"BINANCE",
            symbol,
            t,
            openInterest
          });
          updateStatus(symbol,"lastOpenInterestAt",t);
        }
      } catch (error) {
        onStatus({exchange:"BINANCE",healthy:false,event:"openInterestError",symbol,error:String(error?.message||error),at:Date.now()});
      }
    }));
  }

  function start() {
    if (!stopped) return;
    stopped=false;
    onStatus({
      exchange:"BINANCE",
      healthy:false,
      event:"starting",
      publicUrl:combinedUrl(PUBLIC_BASE,publicStreams(wanted)),
      marketUrl:combinedUrl(MARKET_BASE,marketStreams(wanted)),
      at:Date.now()
    });
    connect();
    pollOpenInterest();
    oiTimer=setRepeater(pollOpenInterest,oiPollMs);
    staleTimer=setRepeater(()=>emitStatus({event:"freshness"}),Math.min(staleMs,5_000));
  }

  function stop() {
    stopped=true;
    closeSockets("stop");
    if (oiTimer) clearRepeater(oiTimer);
    if (staleTimer) clearRepeater(staleTimer);
    if (ageTimer) clearTimer(ageTimer);
    if (reconnectTimer) clearTimer(reconnectTimer);
    oiTimer=staleTimer=ageTimer=reconnectTimer=null;
  }

  return {
    start,stop,pollOpenInterest,
    status:()=>({symbols:wanted,latest:Object.fromEntries(latest),stopped}),
    urls:{
      public:combinedUrl(PUBLIC_BASE,publicStreams(wanted)),
      market:combinedUrl(MARKET_BASE,marketStreams(wanted))
    }
  };
}
