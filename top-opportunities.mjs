// Selective user-facing opportunity ranking.
// Research/paper trading may remain broad; this module intentionally exposes <= 5 setups.

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const n=(x,d=0)=>Number.isFinite(Number(x))?Number(x):d;
const side=x=>String(x||'').toUpperCase();

export function scoreOpportunity(candidate, context={}) {
  const direction=side(candidate.signal||candidate.action||candidate.side);
  if(!['LONG','SHORT'].includes(direction)) return null;
  const sign=direction==='LONG'?1:-1;
  const p=clamp(n(candidate.p_t1??candidate.probability,0),0,1);
  const ev=n(candidate.expected_value,0);
  const spread=n(candidate.spread_bps??candidate.snapshot?.feature?.spread_bps,999);
  const fresh=(candidate.data_quality||'HIGH')==='HIGH' && spread<12;
  if(!fresh) return null;

  const h1=n(context.h1Trend??candidate.snapshot?.feature?.return_15m,0)*sign;
  const h4=n(context.h4Trend??candidate.snapshot?.h4Trend,0)*sign;
  const d1=n(context.d1Trend??candidate.snapshot?.d1Trend,0)*sign;
  const mtf=n(context.mtfAlignment??candidate.snapshot?.mtfAlignment,0)*sign;
  const cycle=n(context.cycleBias??candidate.snapshot?.cycleBias,0)*sign;
  const flow=n(context.flow??candidate.snapshot?.feature?.cvd_10m,0)*sign;
  const book=n(context.orderbook??candidate.snapshot?.feature?.orderbook_imbalance,0)*sign;
  const oi=n(context.openInterestImpulse??candidate.snapshot?.open_interest_impulse,0)*sign;
  const funding=n(context.fundingSupport??candidate.snapshot?.funding_support,0);
  const fib=n(context.fibConfluence??candidate.snapshot?.fib_confluence,0);
  const ma=n(context.maStructure??candidate.snapshot?.ma_structure,0)*sign;
  const macd=n(context.macd??candidate.snapshot?.macd_signal,0)*sign;
  const rsi=n(context.rsiQuality??candidate.snapshot?.rsi_quality,0);
  const rr=n(context.rewardRisk??candidate.snapshot?.reward_risk,1);

  // Evidence families are capped so correlated indicators cannot manufacture confidence.
  const trend=clamp(0.15*h1+0.30*h4+0.40*d1+0.15*mtf,-1,1);
  const technical=clamp(0.35*ma+0.25*macd+0.20*rsi+0.20*fib,-1,1);
  const positioning=clamp(0.40*flow+0.20*book+0.25*oi+0.15*funding,-1,1);
  const regime=clamp(0.65*cycle+0.35*trend,-1,1);

  // Hard conflict: do not promote a short-term setup against strong D1/H4 evidence.
  if(d1 < -0.55 && h4 < -0.35) return null;
  if(p < 0.50 || ev<=0 || rr<1) return null;

  const score=100*clamp(
    0.30*p +
    0.20*((trend+1)/2) +
    0.14*((regime+1)/2) +
    0.12*((technical+1)/2) +
    0.12*((positioning+1)/2) +
    0.07*clamp(rr/3,0,1) +
    0.05*clamp(1-spread/12,0,1),
    0,1
  );

  return {
    ...candidate,
    opportunity_score:Number(score.toFixed(2)),
    evidence:{trend,regime,technical,positioning,rewardRisk:rr,spreadBps:spread},
    rank_reason:[
      trend>0.35?'D1/H4 trend aligned':null,
      cycle>0.25?'cycle/regime supportive':null,
      technical>0.25?'MA/MACD/RSI/Fibonacci confluence':null,
      positioning>0.25?'flow/OI/funding/book supportive':null,
      rr>=2?'reward:risk >= 2':null
    ].filter(Boolean)
  };
}

export function rankTopOpportunities(candidates=[], contexts={}, limit=5) {
  const bestByAsset=new Map();
  for(const c of candidates){
    const key=c.asset_id||c.symbol;
    if(!key) continue;
    const scored=scoreOpportunity(c,contexts[key]||{});
    if(!scored) continue;
    const prior=bestByAsset.get(key);
    if(!prior||scored.opportunity_score>prior.opportunity_score) bestByAsset.set(key,scored);
  }
  return [...bestByAsset.values()]
    .sort((a,b)=>b.opportunity_score-a.opportunity_score)
    .slice(0,Math.max(0,Math.min(5,limit)));
}
