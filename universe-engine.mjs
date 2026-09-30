const STABLE = new Set(["USDT","USDC","USDE","DAI","FDUSD","TUSD","USDD","PYUSD","USDP","BUSD"]);
const WRAPPED = /^(W|WBTC|WETH|STETH|WSTETH|CBETH|RETH|FRAX|SUSDE|SUSDS)/i;
const LEVERAGED = /(3L|3S|5L|5S|2L|2S|BULL|BEAR|UP|DOWN)$/i;

export function isEligibleInstrument(x) {
  const s = String(x.symbol || "").toUpperCase().replace(/USDT$/, "");
  return x.status === "Trading" &&
    x.quoteCoin === "USDT" &&
    x.contractType === "LinearPerpetual" &&
    !STABLE.has(s) &&
    !WRAPPED.test(s) &&
    !LEVERAGED.test(s);
}

function clamp01(x){ return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function log10(x){ return Math.log10(Math.max(1, Number(x)||0)); }

export function rankEligibleUniverse(info=[], tickers=[], bookBySymbol=new Map(), maxAssets=30) {
  const instruments = new Map(info.filter(isEligibleInstrument).map(x=>[String(x.symbol).toUpperCase(),x]));
  const candidates = [];
  for (const t of tickers) {
    const symbol=String(t.symbol||"").toUpperCase();
    const ins=instruments.get(symbol);
    if(!ins) continue;
    const turnover=Number(t.turnover24h||0);
    const volume=Number(t.volume24h||0);
    const price=Number(t.lastPrice||t.markPrice||0);
    const funding=Math.abs(Number(t.fundingRate||0));
    const book=bookBySymbol.get(symbol)||{};
    const spread=Number(book.spreadBps);
    const depth=Number(book.depthUsd);
    const fresh=book.fresh===true;
    if(!(turnover>0 && price>0)) continue;
    // Entry eligibility is dynamic: liquidity + tradability + microstructure quality.
    const liquidity=clamp01((log10(turnover)-6)/3);
    const volumeScore=clamp01((log10(volume)-5)/4);
    const spreadScore=Number.isFinite(spread)?clamp01(1-spread/15):0.35;
    const depthScore=clamp01(log10(depth)/8);
    const freshness=fresh?1:0.25;
    const fundingPenalty=clamp01(funding/0.002);
    const score=100*(0.34*liquidity+0.18*volumeScore+0.20*spreadScore+0.18*depthScore+0.10*freshness)*(1-0.10*fundingPenalty);
    candidates.push({
      symbol:symbol, baseAsset:ins.baseCoin||symbol.replace(/USDT$/,""), price,
      turnover24h:turnover, volume24h:volume, spreadBps:Number.isFinite(spread)?spread:null,
      depthUsd:Number.isFinite(depth)?depth:null, eligibilityScore:Number(score.toFixed(4)),
      eligibility:{trading:true,liquidity:liquidity>=0.2,spread:spreadScore>=0.2,depth:depthScore>=0.15,dataFresh:fresh},
      selectionBasis:"dynamic_liquidity_microstructure"
    });
  }
  return candidates.sort((a,b)=>b.eligibilityScore-a.eligibilityScore).slice(0,maxAssets);
}
