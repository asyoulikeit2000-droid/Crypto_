function finite(v, fallback = 0) {
  const n=Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function createBinanceFeatureBridge({ intelligence } = {}) {
  if (!intelligence?.onTrade || !intelligence?.onBook) throw new Error("intelligence engine required");
  const metadata=new Map();

  function id(symbol){ return "binance:"+String(symbol||"").toLowerCase().replace(/usdt$/,""); }

  function onTrade(row) {
    intelligence.onTrade(id(row.symbol),{
      t:finite(row.t,Date.now()),
      price:finite(row.price),
      qty:finite(row.qty),
      side:row.side
    });
  }

  function onBook(row) {
    if (row.type !== "depth") return;
    intelligence.onBook(id(row.symbol),{
      updatedAt:finite(row.t,Date.now()),
      imbalance:finite(row.imbalance),
      spreadBps:finite(row.spreadBps),
      depthUsd:finite(row.depthUsd),
      bidDepthUsd:finite(row.bidDepthUsd),
      askDepthUsd:finite(row.askDepthUsd)
    });
  }

  function onMark(row) {
    const key=id(row.symbol);
    const prev=metadata.get(key)||{};
    metadata.set(key,{...prev,mark:row});
  }

  function onOpenInterest(row) {
    const key=id(row.symbol);
    const prev=metadata.get(key)||{};
    const previous=prev.openInterest;
    metadata.set(key,{...prev,openInterest:row,previousOpenInterest:previous});
  }

  function features(symbol) {
    const key=id(symbol);
    const f=intelligence.features(key);
    const meta=metadata.get(key)||{};
    const oi=meta.openInterest;
    const prevOi=meta.previousOpenInterest;
    const oiNow=finite(oi?.openInterest,0);
    const oiPrev=finite(prevOi?.openInterest,0);
    const oiChange=oiPrev>0 ? (oiNow-oiPrev)/oiPrev : 0;
    return {
      ...f,
      exchange:"BINANCE",
      symbol:String(symbol||"").toUpperCase(),
      funding_rate:finite(meta.mark?.fundingRate,0),
      next_funding_time:finite(meta.mark?.nextFundingTime,null),
      mark_price:finite(meta.mark?.markPrice,null),
      open_interest:oiNow || null,
      open_interest_change:oiChange,
      open_interest_updated_at:finite(oi?.t,null)
    };
  }

  return { id,onTrade,onBook,onMark,onOpenInterest,features };
}
