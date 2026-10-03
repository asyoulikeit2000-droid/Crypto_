const EXCHANGE_INFO="https://fapi.binance.com/fapi/v1/exchangeInfo";
const TICKER_24H="https://fapi.binance.com/fapi/v1/ticker/24hr";
const BOOK_TICKER="https://fapi.binance.com/fapi/v1/ticker/bookTicker";

const STABLE=new Set(["USDT","USDC","USDE","DAI","FDUSD","TUSD","USDD","PYUSD","USDP","BUSD"]);
const WRAPPED=/^(W|WBTC|WETH|STETH|WSTETH|CBETH|RETH|FRAX|SUSDE|SUSDS)/i;
const LEVERAGED=/(3L|3S|5L|5S|2L|2S|BULL|BEAR|UP|DOWN)$/i;

function finite(v,fallback=0){
  const n=Number(v);
  return Number.isFinite(n)?n:fallback;
}
function clamp01(x){ return Math.max(0,Math.min(1,finite(x))); }
function log10(x){ return Math.log10(Math.max(1,finite(x,1))); }
function upper(v){ return String(v||"").toUpperCase(); }

export function isEligibleBinancePerpetual(x={}){
  const symbol=upper(x.symbol);
  const base=upper(x.baseAsset || symbol.replace(/USDT$/,""));
  return x.status==="TRADING" &&
    x.contractType==="PERPETUAL" &&
    x.quoteAsset==="USDT" &&
    x.marginAsset==="USDT" &&
    symbol.endsWith("USDT") &&
    !STABLE.has(base) &&
    !WRAPPED.test(base) &&
    !LEVERAGED.test(base);
}

export function rankBinanceResearchUniverse({
  exchangeInfo=[],
  tickers=[],
  books=[],
  maxAssets=10,
  pinned=["BTCUSDT"],
  minQuoteVolumeUsd=25_000_000,
  maxSpreadBps=8
} = {}) {
  const instruments=new Map(
    (exchangeInfo||[]).filter(isEligibleBinancePerpetual).map(x=>[upper(x.symbol),x])
  );
  const bookMap=new Map((books||[]).map(x=>[upper(x.symbol),x]));
  const candidates=[];

  for(const t of tickers||[]){
    const symbol=upper(t.symbol);
    const ins=instruments.get(symbol);
    if(!ins) continue;

    const quoteVolume=finite(t.quoteVolume);
    const trades=Math.max(0,finite(t.count));
    const lastPrice=finite(t.lastPrice);
    const book=bookMap.get(symbol)||{};
    const bid=finite(book.bidPrice);
    const ask=finite(book.askPrice);
    const mid=bid>0&&ask>0?(bid+ask)/2:0;
    const spreadBps=mid>0?(ask-bid)/mid*10_000:Infinity;

    if(!(quoteVolume>=finite(minQuoteVolumeUsd,25_000_000)) || !(lastPrice>0)) continue;
    if(!(spreadBps<=finite(maxSpreadBps,8))) continue;

    const volumeScore=clamp01((log10(quoteVolume)-7)/4);
    const activityScore=clamp01((log10(trades)-3)/4);
    const spreadScore=clamp01(1-spreadBps/Math.max(1,finite(maxSpreadBps,8)));
    const score=100*(0.55*volumeScore+0.20*activityScore+0.25*spreadScore);

    candidates.push({
      symbol,
      baseAsset:upper(ins.baseAsset),
      quoteVolumeUsd:quoteVolume,
      tradeCount:trades,
      lastPrice,
      spreadBps,
      score:Number(score.toFixed(4))
    });
  }

  candidates.sort((a,b)=>b.score-a.score || b.quoteVolumeUsd-a.quoteVolumeUsd);

  const result=[];
  const seen=new Set();
  for(const symbol of pinned||[]){
    const s=upper(symbol);
    const row=candidates.find(x=>x.symbol===s);
    if(row && !seen.has(s)){
      result.push({...row,pinned:true});
      seen.add(s);
    }
  }
  for(const row of candidates){
    if(result.length>=Math.max(1,Math.floor(finite(maxAssets,10)))) break;
    if(seen.has(row.symbol)) continue;
    result.push({...row,pinned:false});
    seen.add(row.symbol);
  }
  return result;
}

async function getJson(fetchImpl,url){
  const res=await fetchImpl(url,{headers:{"user-agent":"crypto-shadow-research/1.0"}});
  if(!res?.ok) throw new Error("Binance universe HTTP "+(res?.status??"unknown"));
  return res.json();
}

export async function resolveBinanceResearchUniverse({
  fetchImpl=globalThis.fetch,
  maxAssets=10,
  pinned=["BTCUSDT"],
  minQuoteVolumeUsd=25_000_000,
  maxSpreadBps=8
} = {}) {
  if(typeof fetchImpl!=="function") throw new Error("fetch unavailable");
  const [info,tickers,books]=await Promise.all([
    getJson(fetchImpl,EXCHANGE_INFO),
    getJson(fetchImpl,TICKER_24H),
    getJson(fetchImpl,BOOK_TICKER)
  ]);
  return rankBinanceResearchUniverse({
    exchangeInfo:info?.symbols||[],
    tickers:Array.isArray(tickers)?tickers:[],
    books:Array.isArray(books)?books:[],
    maxAssets,pinned,minQuoteVolumeUsd,maxSpreadBps
  });
}
