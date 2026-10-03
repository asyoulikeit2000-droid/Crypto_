function finite(v,fallback=0){
  const n=Number(v);
  return Number.isFinite(n)?n:fallback;
}
function upper(v){ return String(v||"").toUpperCase(); }

export function targetMakerFill({
  positionSide,
  targetPrice,
  trades=[],
  sinceMs=0,
  untilMs=Date.now()
} = {}) {
  const side=upper(positionSide);
  const target=finite(targetPrice);
  if(!["BUY","SELL"].includes(side) || !(target>0)){
    return {filled:false,reason:"invalidTarget"};
  }

  const closingAggressor=side==="BUY" ? "BUY" : "SELL";
  const rows=(trades||[])
    .filter(x=>finite(x?.t)>=finite(sinceMs) && finite(x?.t)<=finite(untilMs))
    .sort((a,b)=>finite(a.t)-finite(b.t));

  for(const trade of rows){
    const p=finite(trade?.price);
    if(upper(trade?.side)!==closingAggressor || !(p>0)) continue;
    if(side==="BUY" && p>target){
      return {
        filled:true,
        exitPrice:target,
        fillAt:finite(trade.t,untilMs),
        reason:"makerTargetTradedThrough",
        observedTradePrice:p,
        exitLiquidity:"MAKER"
      };
    }
    if(side==="SELL" && p<target){
      return {
        filled:true,
        exitPrice:target,
        fillAt:finite(trade.t,untilMs),
        reason:"makerTargetTradedThrough",
        observedTradePrice:p,
        exitLiquidity:"MAKER"
      };
    }
  }
  return {filled:false,reason:"targetNotTradedThrough"};
}


export function resolveExitTrigger({
  positionSide,
  stopPrice,
  targetPrice,
  trades=[],
  sinceMs=0,
  untilMs=Date.now(),
  bestBid,
  bestAsk,
  expired=false
} = {}) {
  const side=upper(positionSide);
  const stop=finite(stopPrice);
  const target=finite(targetPrice);
  if(!["BUY","SELL"].includes(side) || !(stop>0) || !(target>0)){
    return {triggered:false,reason:"invalidBarriers"};
  }

  const rows=(trades||[])
    .filter(x=>finite(x?.t)>=finite(sinceMs) && finite(x?.t)<=finite(untilMs))
    .sort((a,b)=>finite(a.t)-finite(b.t));

  for(const trade of rows){
    const p=finite(trade?.price);
    const aggressor=upper(trade?.side);
    if(!(p>0)) continue;

    if(side==="BUY"){
      if(p<=stop) return {triggered:true,exitReason:"STOP",at:finite(trade.t,untilMs),exitLiquidity:"TAKER",observedTradePrice:p};
      if(aggressor==="BUY" && p>target) return {triggered:true,exitReason:"TARGET",at:finite(trade.t,untilMs),exitLiquidity:"MAKER",observedTradePrice:p};
    } else {
      if(p>=stop) return {triggered:true,exitReason:"STOP",at:finite(trade.t,untilMs),exitLiquidity:"TAKER",observedTradePrice:p};
      if(aggressor==="SELL" && p<target) return {triggered:true,exitReason:"TARGET",at:finite(trade.t,untilMs),exitLiquidity:"MAKER",observedTradePrice:p};
    }
  }

  const bid=finite(bestBid);
  const ask=finite(bestAsk);
  if(side==="BUY" && bid>0 && bid<=stop){
    return {triggered:true,exitReason:"STOP",at:finite(untilMs),exitLiquidity:"TAKER",observedTradePrice:bid,reason:"bookCrossedStop"};
  }
  if(side==="SELL" && ask>0 && ask>=stop){
    return {triggered:true,exitReason:"STOP",at:finite(untilMs),exitLiquidity:"TAKER",observedTradePrice:ask,reason:"bookCrossedStop"};
  }
  if(expired){
    return {triggered:true,exitReason:"TIME",at:finite(untilMs),exitLiquidity:"TAKER",reason:"maxHold"};
  }
  return {triggered:false,reason:"noExit"};
}

export function walkMarketExit({
  positionSide,
  positionQty,
  book,
  fallbackPrice,
  missingDepthPenaltyBps=10
} = {}) {
  const side=upper(positionSide);
  const qty=Math.max(0,finite(positionQty));
  if(!["BUY","SELL"].includes(side) || !(qty>0)){
    return {valid:false,reason:"invalidPosition"};
  }

  const closingAction=side==="BUY" ? "SELL" : "BUY";
  const rows=closingAction==="SELL" ? (book?.bids||[]) : (book?.asks||[]);
  const clean=(rows||[])
    .map(x=>[finite(x?.[0]),Math.max(0,finite(x?.[1]))])
    .filter(([p,q])=>p>0 && q>0);

  if(!clean.length){
    const base=finite(fallbackPrice);
    if(!(base>0)) return {valid:false,reason:"missingBook"};
    const adverse=missingDepthPenaltyBps/10_000;
    const price=closingAction==="SELL" ? base*(1-adverse) : base*(1+adverse);
    return {
      valid:true,
      fullyVisible:false,
      closingAction,
      exitPrice:price,
      positionQty:qty,
      visibleFilledQty:0,
      syntheticFilledQty:qty,
      bestPrice:base,
      worstVisiblePrice:null,
      impactBps:missingDepthPenaltyBps,
      reason:"fallbackPenalty"
    };
  }

  const best=clean[0][0];
  let remaining=qty;
  let quote=0;
  let visibleFilled=0;
  let worst=best;

  for(const [price,available] of clean){
    if(remaining<=0) break;
    const fill=Math.min(remaining,available);
    quote+=fill*price;
    visibleFilled+=fill;
    remaining-=fill;
    worst=price;
  }

  let syntheticFilled=0;
  if(remaining>0){
    const adverse=missingDepthPenaltyBps/10_000;
    const syntheticPrice=closingAction==="SELL"
      ? worst*(1-adverse)
      : worst*(1+adverse);
    quote+=remaining*syntheticPrice;
    syntheticFilled=remaining;
    remaining=0;
  }

  const exitPrice=quote/qty;
  const impactBps=closingAction==="SELL"
    ? Math.max(0,(best-exitPrice)/best*10_000)
    : Math.max(0,(exitPrice-best)/best*10_000);

  return {
    valid:true,
    fullyVisible:syntheticFilled===0,
    closingAction,
    exitPrice,
    positionQty:qty,
    visibleFilledQty:visibleFilled,
    syntheticFilledQty:syntheticFilled,
    bestPrice:best,
    worstVisiblePrice:worst,
    impactBps,
    reason:syntheticFilled?"visibleDepthExhausted":"bookWalk"
  };
}

export function actualExitFeesUsd({
  entryNotionalUsd,
  exitNotionalUsd,
  entryLiquidity="MAKER",
  exitLiquidity="TAKER",
  makerFeeRate=0.0002,
  takerFeeRate=0.0005
} = {}) {
  const entry=Math.max(0,finite(entryNotionalUsd));
  const exit=Math.max(0,finite(exitNotionalUsd));
  const maker=Math.max(0,finite(makerFeeRate));
  const taker=Math.max(0,finite(takerFeeRate));
  const entryRate=upper(entryLiquidity)==="TAKER"?taker:maker;
  const exitRate=upper(exitLiquidity)==="MAKER"?maker:taker;
  return entry*entryRate+exit*exitRate;
}
