function finite(v, fallback = 0) {
  const n=Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function createBinanceFeatureBridge({ intelligence } = {}) {
  if (!intelligence?.onTrade || !intelligence?.onBook) throw new Error("intelligence engine required");
  const metadata=new Map();

  function id(symbol){ return "binance:"+String(symbol||"").toLowerCase().replace(/usdt$/,""); }

  function onTrade(row) {
    const key=id(row.symbol);
    intelligence.onTrade(key,{
      t:finite(row.t,Date.now()),
      price:finite(row.price),
      qty:finite(row.qty),
      side:row.side
    });
    const prev=metadata.get(key)||{};
    const t=finite(row.t,Date.now());
    const recent=[...(prev.recentTrades||[]),{
      t,
      price:finite(row.price),
      qty:finite(row.qty),
      side:String(row.side||"").toUpperCase()
    }].filter(x=>t-finite(x.t)<=120_000).slice(-5000);
    metadata.set(key,{...prev,lastTrade:row,recentTrades:recent});
  }

  function onBook(row) {
    if (row.type !== "depth") return;
    const key=id(row.symbol);
    intelligence.onBook(key,{
      updatedAt:finite(row.t,Date.now()),
      imbalance:finite(row.imbalance),
      spreadBps:finite(row.spreadBps),
      depthUsd:finite(row.depthUsd),
      bidDepthUsd:finite(row.bidDepthUsd),
      askDepthUsd:finite(row.askDepthUsd)
    });
    const prev=metadata.get(key)||{};
    metadata.set(key,{...prev,book:row});
  }

  function onMark(row) {
    const key=id(row.symbol);
    const prev=metadata.get(key)||{};
    const prior=prev.mark;
    let fundingEvents=[...(prev.fundingEvents||[])];
    const priorFundingTime=finite(prior?.nextFundingTime,null);
    const currentTime=finite(row?.t,Date.now());
    const nextFundingTime=finite(row?.nextFundingTime,null);
    if(
      priorFundingTime!=null &&
      currentTime>=priorFundingTime &&
      nextFundingTime!=null &&
      nextFundingTime!==priorFundingTime
    ){
      fundingEvents.push({
        t:priorFundingTime,
        rate:finite(prior?.fundingRate,0),
        markPrice:finite(prior?.markPrice,null)
      });
    }
    fundingEvents=fundingEvents
      .filter(x=>currentTime-finite(x?.t,currentTime)<=24*60*60*1000)
      .slice(-20);
    metadata.set(key,{...prev,mark:row,fundingEvents});
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
      open_interest_updated_at:finite(oi?.t,null),
      best_bid:finite(meta.book?.bestBid,null),
      best_ask:finite(meta.book?.bestAsk,null),
      best_bid_qty:finite(meta.book?.bids?.[0]?.[1],0),
      best_ask_qty:finite(meta.book?.asks?.[0]?.[1],0),
      book_updated_at:finite(meta.book?.t,null),
      last_trade_price:finite(meta.lastTrade?.price,null),
      last_trade_side:String(meta.lastTrade?.side||"").toUpperCase()||null,
      last_trade_at:finite(meta.lastTrade?.t,null)
    };
  }

  function tradesSince(symbol,sinceMs=0) {
    const rows=metadata.get(id(symbol))?.recentTrades || [];
    return rows.filter(x=>finite(x.t)>=finite(sinceMs));
  }

  function fundingEventsSince(symbol,sinceMs=0,untilMs=Infinity) {
    const rows=metadata.get(id(symbol))?.fundingEvents || [];
    const from=finite(sinceMs,0);
    const to=finite(untilMs,Infinity);
    return rows.filter(x=>finite(x.t)>=from && finite(x.t)<=to);
  }

  return { id,onTrade,onBook,onMark,onOpenInterest,features,tradesSince,fundingEventsSince };
}
