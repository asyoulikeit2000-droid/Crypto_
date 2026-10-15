function finite(v,fallback=null){
  const n=Number(v);
  return Number.isFinite(n)?n:fallback;
}
function upper(v){ return String(v||"").toUpperCase(); }

export function executableExitPrice(features={},side){
  const s=upper(side);
  const fallback=finite(features.price ?? features.last_trade_price ?? features.mark_price);
  if(s==="BUY") return finite(features.best_bid,fallback);
  if(s==="SELL") return finite(features.best_ask,fallback);
  return fallback;
}

export function fundingCostUsd({
  side,
  notionalUsd,
  openedAtMs,
  closedAtMs=Date.now(),
  events=[],
  fallbackRate,
  fallbackFundingTime
}={}){
  const s=upper(side);
  const notional=Math.max(0,finite(notionalUsd,0));
  const from=finite(openedAtMs,0);
  const to=finite(closedAtMs,Date.now());
  if(!["BUY","SELL"].includes(s) || !(notional>0) || !(to>=from)) return 0;

  const seen=new Set();
  let rateSum=0;
  for(const e of events||[]){
    const t=finite(e?.t);
    const rate=finite(e?.rate);
    if(t==null || rate==null || t<from || t>to) continue;
    const k=String(t);
    if(seen.has(k)) continue;
    seen.add(k);
    rateSum+=rate;
  }

  const ft=finite(fallbackFundingTime);
  const fr=finite(fallbackRate);
  if(!seen.size && ft!=null && fr!=null && ft>=from && ft<=to){
    rateSum+=fr;
  }

  const direction=s==="BUY"?1:-1;
  return notional*rateSum*direction;
}
