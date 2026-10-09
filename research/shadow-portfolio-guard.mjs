function finite(v,fallback=0){
  const n=Number(v);
  return Number.isFinite(n)?n:fallback;
}
function upper(v){ return String(v||"").toUpperCase(); }

export function summarizeShadowExposure({
  openTrials=[],
  pending=[],
  equityUsd=0
} = {}) {
  const equity=Math.max(0,finite(equityUsd));
  const rows=[];

  for(const trial of openTrials||[]){
    rows.push({
      kind:"OPEN",
      symbol:upper(trial?.symbol),
      side:upper(trial?.side),
      notionalUsd:Math.max(0,finite(trial?.notional_usd)),
      riskUsd:Math.max(0,finite(trial?.metadata?.risk_usd))
    });
  }

  for(const state of pending||[]){
    const order=state?.order||state;
    const attempt=state?.attempt||{};
    rows.push({
      kind:"PENDING",
      symbol:upper(order?.symbol||attempt?.symbol),
      side:upper(order?.side||attempt?.side),
      notionalUsd:Math.max(0,finite(order?.notionalUsd||attempt?.notional_usd)),
      riskUsd:Math.max(0,finite(attempt?.metadata?.risk_usd))
    });
  }

  const totalNotionalUsd=rows.reduce((s,x)=>s+x.notionalUsd,0);
  const aggregateRiskUsd=rows.reduce((s,x)=>s+x.riskUsd,0);
  const longNotionalUsd=rows.filter(x=>x.side==="BUY").reduce((s,x)=>s+x.notionalUsd,0);
  const shortNotionalUsd=rows.filter(x=>x.side==="SELL").reduce((s,x)=>s+x.notionalUsd,0);

  return {
    equityUsd:equity,
    reservedSlots:rows.length,
    openCount:rows.filter(x=>x.kind==="OPEN").length,
    pendingCount:rows.filter(x=>x.kind==="PENDING").length,
    totalNotionalUsd,
    longNotionalUsd,
    shortNotionalUsd,
    aggregateRiskUsd,
    totalNotionalPct:equity>0?totalNotionalUsd/equity:Infinity,
    longNotionalPct:equity>0?longNotionalUsd/equity:Infinity,
    shortNotionalPct:equity>0?shortNotionalUsd/equity:Infinity,
    aggregateRiskPct:equity>0?aggregateRiskUsd/equity:Infinity,
    symbols:[...new Set(rows.map(x=>x.symbol).filter(Boolean))]
  };
}

export function evaluateShadowAdmission(candidate={},exposure={},policy={}){
  const failed=[];
  const equity=Math.max(0,finite(exposure.equityUsd));
  const side=upper(candidate.side);
  const symbol=upper(candidate.symbol);
  const notional=Math.max(0,finite(candidate.notionalUsd));
  const risk=Math.max(0,finite(candidate.riskUsd));

  const maxSlots=Math.max(1,Math.floor(finite(policy.maxConcurrentPositions,2)));
  const maxTotalPct=Math.max(0.1,finite(policy.maxTotalNotionalPct,1.5));
  const maxDirectionalPct=Math.max(0.1,finite(policy.maxDirectionalNotionalPct,1.25));
  const maxAggregateRiskPct=Math.max(0.0001,finite(policy.maxAggregateRiskPct,0.004));

  if(!(equity>0)) failed.push("equityUnavailable");
  if(!["BUY","SELL"].includes(side)) failed.push("invalidSide");
  if(!(notional>0)) failed.push("invalidNotional");
  if(!symbol) failed.push("invalidSymbol");
  if(finite(exposure.reservedSlots)>=maxSlots) failed.push("maxConcurrentPositions");
  if((exposure.symbols||[]).includes(symbol)) failed.push("duplicateSymbol");

  if(equity>0){
    const totalPct=(finite(exposure.totalNotionalUsd)+notional)/equity;
    const directionalExisting=side==="BUY"
      ? finite(exposure.longNotionalUsd)
      : finite(exposure.shortNotionalUsd);
    const directionalPct=(directionalExisting+notional)/equity;
    const aggregateRiskPct=(finite(exposure.aggregateRiskUsd)+risk)/equity;

    if(totalPct>maxTotalPct) failed.push("totalNotional");
    if(directionalPct>maxDirectionalPct) failed.push("directionalNotional");
    if(aggregateRiskPct>maxAggregateRiskPct) failed.push("aggregateRisk");

    return {
      allowed:failed.length===0,
      failed,
      projected:{totalPct,directionalPct,aggregateRiskPct,reservedSlots:finite(exposure.reservedSlots)+1}
    };
  }

  return {allowed:false,failed,projected:null};
}
