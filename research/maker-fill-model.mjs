function finite(v,fallback=0){
  const n=Number(v);
  return Number.isFinite(n)?n:fallback;
}
function sideKey(v){ return String(v||"").toUpperCase(); }

export function buildMakerOrder({
  family,
  symbol,
  side,
  regime,
  score,
  features={},
  notionalUsd,
  stopDistancePct,
  rewardRisk,
  submittedAt=Date.now(),
  ttlMs=30_000,
  queueAheadFraction=0.5
} = {}) {
  const s=sideKey(side);
  const limitPrice=s==="BUY" ? finite(features.best_bid,null) : finite(features.best_ask,null);
  const queueAheadQty=s==="BUY" ? finite(features.best_bid_qty,0) : finite(features.best_ask_qty,0);
  const notional=finite(notionalUsd);
  if(!["BUY","SELL"].includes(s)) return {valid:false,reason:"invalidSide"};
  if(!(limitPrice>0) || !(notional>0)) return {valid:false,reason:"missingBookOrNotional"};
  const orderQty=notional/limitPrice;
  return {
    valid:true,
    family:String(family||""),
    symbol:String(symbol||"").toUpperCase(),
    side:s,
    regime:String(regime||"UNKNOWN"),
    score:finite(score),
    submittedAt:finite(submittedAt,Date.now()),
    expiresAt:finite(submittedAt,Date.now())+Math.max(1,finite(ttlMs,30_000)),
    signalPrice:finite(features.price,limitPrice),
    limitPrice,
    orderQty,
    notionalUsd:notional,
    queueAheadQty,
    queueAheadFraction:Math.max(0,Math.min(1,finite(queueAheadFraction,0.5))),
    stopDistancePct:finite(stopDistancePct),
    rewardRisk:finite(rewardRisk,1.5),
    spreadBps:finite(features.spread_bps),
    bookUpdatedAt:finite(features.book_updated_at,null)
  };
}

export function evaluateMakerFill(order, trades=[], now=Date.now()) {
  if(!order?.valid) return {status:"INVALID",filled:false,reason:order?.reason||"invalidOrder"};
  const relevant=(trades||[])
    .filter(t=>finite(t?.t)>=order.submittedAt && finite(t?.t)<=order.expiresAt)
    .sort((a,b)=>finite(a.t)-finite(b.t));

  const opposingSide=order.side==="BUY" ? "SELL" : "BUY";
  const thresholdQty=Math.max(
    order.orderQty,
    order.orderQty + Math.max(0,order.queueAheadQty)*order.queueAheadFraction
  );
  let atLimitQty=0;

  for(const trade of relevant){
    if(sideKey(trade.side)!==opposingSide) continue;
    const price=finite(trade.price);
    const qty=Math.max(0,finite(trade.qty));
    if(order.side==="BUY"){
      if(price < order.limitPrice){
        return {
          status:"FILLED",filled:true,fillPrice:order.limitPrice,fillAt:finite(trade.t),
          latencyMs:Math.max(0,finite(trade.t)-order.submittedAt),
          reason:"tradedThroughLimit",observedOpposingQty:atLimitQty+qty,thresholdQty
        };
      }
      if(price===order.limitPrice){
        atLimitQty+=qty;
        if(atLimitQty>=thresholdQty){
          return {
            status:"FILLED",filled:true,fillPrice:order.limitPrice,fillAt:finite(trade.t),
            latencyMs:Math.max(0,finite(trade.t)-order.submittedAt),
            reason:"queueConsumed",observedOpposingQty:atLimitQty,thresholdQty
          };
        }
      }
    } else {
      if(price > order.limitPrice){
        return {
          status:"FILLED",filled:true,fillPrice:order.limitPrice,fillAt:finite(trade.t),
          latencyMs:Math.max(0,finite(trade.t)-order.submittedAt),
          reason:"tradedThroughLimit",observedOpposingQty:atLimitQty+qty,thresholdQty
        };
      }
      if(price===order.limitPrice){
        atLimitQty+=qty;
        if(atLimitQty>=thresholdQty){
          return {
            status:"FILLED",filled:true,fillPrice:order.limitPrice,fillAt:finite(trade.t),
            latencyMs:Math.max(0,finite(trade.t)-order.submittedAt),
            reason:"queueConsumed",observedOpposingQty:atLimitQty,thresholdQty
          };
        }
      }
    }
  }

  if(finite(now)>=order.expiresAt){
    return {
      status:"EXPIRED",filled:false,reason:"makerTimeout",
      observedOpposingQty:atLimitQty,thresholdQty
    };
  }

  return {
    status:"PENDING",filled:false,reason:"awaitingMakerFill",
    observedOpposingQty:atLimitQty,thresholdQty
  };
}
