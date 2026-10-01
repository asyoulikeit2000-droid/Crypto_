const clamp=(n,a=0,b=100)=>Math.max(a,Math.min(b,n));
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const present=v=>v!==null&&v!==undefined&&Number.isFinite(Number(v));

export const SCORING_MODEL_VERSION="pre_rally_v1";
export const SCORING_CONFIG_VERSION="2026-10-01";

export function evaluatePreRally(input={}){
  const liquidity=num(input.liquidityUsd), volume24h=num(input.volume24h), volume6h=num(input.volume6h),
    buys1h=num(input.buys1h), sells1h=num(input.sells1h), buys24h=num(input.buys24h), sells24h=num(input.sells24h),
    change1h=num(input.priceChange1h), change6h=num(input.priceChange6h), change24h=num(input.priceChange24h),
    marketCap=num(input.marketCap), fdv=num(input.fdv), pairAgeHours=num(input.pairAgeHours);

  const positive=[], warnings=[], critical=[], missing=[];
  const categories={market_activity:0,liquidity_structure:0,price_structure:0,risk_quality:0};

  if(liquidity!=null){
    if(liquidity>=250000) categories.liquidity_structure+=22;
    else if(liquidity>=100000) categories.liquidity_structure+=15;
    else if(liquidity>=50000) categories.liquidity_structure+=8;
    else critical.push("LOW_LIQUIDITY");
  } else missing.push("liquidity");

  if(volume24h!=null&&liquidity>0){
    const ratio=volume24h/liquidity;
    if(ratio>=0.25&&ratio<=6){categories.market_activity+=10;positive.push("HEALTHY_VOLUME_TO_LIQUIDITY");}
    else if(ratio>12) warnings.push("EXTREME_VOLUME_TO_LIQUIDITY");
  }
  if(volume24h!=null&&volume6h!=null&&volume6h*4>volume24h*1.15){
    categories.market_activity+=12;positive.push("RECENT_VOLUME_ACCELERATION");
  }
  if(buys1h!=null&&sells1h!=null&&buys1h+sells1h>=10){
    const r=buys1h/Math.max(1,sells1h);
    if(r>=1.25){categories.market_activity+=12;positive.push("BUY_COUNT_IMBALANCE_1H");}
    else if(r<=0.7) warnings.push("SELL_COUNT_IMBALANCE_1H");
  }
  if(buys24h!=null&&sells24h!=null&&buys24h>sells24h){
    categories.market_activity+=6;positive.push("BUY_COUNT_IMBALANCE_24H");
  }

  if(change1h!=null&&change6h!=null&&change24h!=null){
    const controlled=Math.abs(change1h)<=12&&Math.abs(change6h)<=25;
    if(controlled&&change6h>=-5&&change24h>=-12){categories.price_structure+=13;positive.push("CONTROLLED_PRICE_STRUCTURE");}
    if(change1h>0&&change6h>0&&change1h<15){categories.price_structure+=8;positive.push("MOMENTUM_IMPROVING");}
    if(change1h>25||change6h>50){warnings.push("PRICE_EXTENDED");categories.price_structure-=8;}
  }

  if(marketCap>0&&liquidity!=null){
    const lr=liquidity/marketCap;
    if(lr>=0.03){categories.liquidity_structure+=8;positive.push("LIQUIDITY_SUPPORTS_MARKET_CAP");}
    else if(lr<0.005) warnings.push("LOW_LIQUIDITY_TO_MARKET_CAP");
  }
  if(fdv>0&&marketCap>0&&fdv/marketCap>=5) warnings.push("HIGH_FDV_TO_MARKET_CAP");
  if(pairAgeHours!=null&&pairAgeHours<24) warnings.push("VERY_YOUNG_PAIR");

  categories.risk_quality=Math.max(0,20-critical.length*20-warnings.length*2);
  const raw=clamp(categories.market_activity+categories.liquidity_structure+categories.price_structure+categories.risk_quality);

  const expected=["liquidityUsd","volume24h","volume6h","buys1h","sells1h","buys24h","sells24h","priceChange1h","priceChange6h","priceChange24h","marketCap","fdv","pairAgeHours"];
  const available=expected.filter(k=>present(input[k])).length;
  const coverage=Math.round(available/expected.length*100);
  expected.filter(k=>!present(input[k])).forEach(k=>{if(!missing.includes(k))missing.push(k)});

  const sourceAgeSec=num(input.sourceAgeSec);
  let confidence=Math.round(coverage*0.68+Math.min(20,positive.length*3)-warnings.length*2-critical.length*12);
  if(sourceAgeSec==null||sourceAgeSec>300){confidence-=15;warnings.push("STALE_OR_UNKNOWN_SOURCE_TIME");}
  if(input.providerCount==null||Number(input.providerCount)<=1) confidence=Math.min(confidence,65);
  confidence=clamp(confidence);

  let classification="neutral";
  if(coverage<40) classification="insufficient_data";
  else if(critical.length) classification="avoid";
  else if(raw>=80&&confidence>=70&&positive.length>=3) classification="high_priority_watch";
  else if(raw>=70&&confidence>=50) classification="research_candidate";
  else if(raw>=58&&confidence>=40) classification="watchlist_candidate";

  return {
    preRallyScore:Math.round(raw), confidenceScore:Math.round(confidence), dataCoverageScore:coverage,
    classification, categoryScores:categories, positiveSignals:[...new Set(positive)],
    warningFlags:[...new Set(warnings)], criticalFlags:[...new Set(critical)], missingData:[...new Set(missing)],
    explanation: classification==="insufficient_data" ? "Limited evidence: more fresh data is required before ranking this token." :
      critical.length ? "Critical market-structure risk is present; the token is not eligible for high-priority classification." :
      positive.length ? "Potential setup with "+positive.length+" supporting market signals; requires manual validation." :
      "No strong accumulation or momentum combination is currently detected.",
    modelVersion:SCORING_MODEL_VERSION, configVersion:SCORING_CONFIG_VERSION
  };
}
