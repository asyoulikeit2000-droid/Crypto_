export const MODEL = 'mtf_free_closed_v1';
export const INTERVALS = {H1: 3_600_000, H4: 14_400_000, D1: 86_400_000};
export const DAILY_CAP = 4;
export const FEE_RATE = 0.00055;
export const SLIPPAGE_RATE = 0.00015;
const finite = v => v !== null && v !== '' && Number.isFinite(Number(v));
const mean = a => a.reduce((s,v)=>s+v,0)/a.length;
export const reviewDay = ms => new Date(ms + 4*3_600_000).toISOString().slice(0,10);
export function closedCandles(rows, interval, now) {
  const ms = INTERVALS[interval] || interval;
  return [...new Map((rows || []).filter(r=>Array.isArray(r) && r.length>=7 && r.slice(0,7).every(finite)).map(r=>r.slice(0,7).map(Number)).filter(r=>r[0]%ms===0 && r[0]+ms<=now && r[1]>0 && r[2]>=Math.max(r[1],r[4]) && r[3]<=Math.min(r[1],r[4]) && r[3]>0 && r[5]>=0 && r[6]>=0).map(r=>[r[0],r])).values()].sort((a,b)=>a[0]-b[0]).slice(-(typeof interval === 'number' ? 1000 : 220));
}
export function candleCoverage(rows, interval, now) {
  const ms=INTERVALS[interval];
  return rows?.length>=200 && rows.at(-1)[0]===Math.floor(now/ms)*ms-ms && rows.every((r,i)=>!i || r[0]-rows[i-1][0]===ms);
}
export function ema(values, period) {
  let v=mean(values.slice(0,period));
  for(let i=period;i<values.length;i++) v+=(values[i]-v)*2/(period+1);
  return v;
}
function atr(bars) { return mean(bars.slice(-14).map((r,i)=>{const prev=bars[bars.length-14+i-1][4];return Math.max(r[2]-r[3],Math.abs(r[2]-prev),Math.abs(r[3]-prev));})); }
function trend(bars) {
  const c=bars.map(r=>r[4]), fast=ema(c,20), slow=ema(c,50), prior=ema(c.slice(0,-3),20);
  return {side:c.at(-1)>fast && fast>slow && fast>prior?1:c.at(-1)<fast && fast<slow && fast<prior?-1:0,fast,slow,atr:atr(bars)};
}
export function freshness(market, now) {
  const age = t => finite(t) && Number(t)>0 && Number(t)<=now+5000 ? Math.max(0,now-Number(t)) : null;
  const bookAgeMs=age(market?.bookAt),tradeAgeMs=age(market?.tradeAt),receivedAgeMs=age(market?.receivedAt);
  return {bookAgeMs,tradeAgeMs,receivedAgeMs,fresh:bookAgeMs!==null && tradeAgeMs!==null && receivedAgeMs!==null && bookAgeMs<=90_000 && tradeAgeMs<=90_000 && receivedAgeMs<=90_000};
}
export function scenarios(entry, stop, targets, direction, notional=1000) {
  const side=direction==='LONG'?1:-1;
  const calc=exit=>{ const gross=side*(exit-entry)/entry*notional; const fees=FEE_RATE*notional*(1+exit/entry);const slippage=SLIPPAGE_RATE*notional*(1+exit/entry); return {price:exit,grossUsd:gross,feesUsd:fees,slippageUsd:slippage,netBeforeFundingUsd:gross-fees-slippage}; };
  return {notionalUsd:notional,stop:calc(stop),targets:targets.map(calc),expectedPnlUsd:null,funding:'Excluded: future settlement rates are unknown',assumption:'Independent full-position exits, no leverage; not a probability-weighted forecast'};
}
export function evaluateMtf(symbol, history, market, btcHistory, now) {
  const reject=reason=>({symbol,eligible:false,reason});
  if(!['H1','H4','D1'].every(tf=>candleCoverage(history?.[tf],tf,now))) return reject('Need 200+ continuous, current closed candles on H1/H4/D1');
  if(!freshness(market,now).fresh) return reject('Market feed stale or unavailable');
  if(!finite(market.price)||market.price<=0||!finite(market.spreadBps)||market.spreadBps<0||market.spreadBps>6||!finite(market.turnover24h)||market.turnover24h<50_000_000) return reject('Liquidity/spread filter');
  if(!finite(market.fundingRate)||Math.abs(market.fundingRate)>0.0005||!finite(market.oiChange)||market.oiChange<-.015||!market.oiAt||now-market.oiAt>900_000||market.oiAt>now+5000) return reject('Funding or open-interest evidence missing/adverse');
  const d=trend(history.D1),h4=trend(history.H4),h1=trend(history.H1),side=d.side;
  if(!side || h4.side!==side || h1.side!==side) return reject('D1/H4/H1 trends disagree');
  if(symbol!=='BTCUSDT') {
    if(!candleCoverage(btcHistory?.D1,'D1',now)||!candleCoverage(btcHistory?.H4,'H4',now)) return reject('BTC regime unavailable');
    if(trend(btcHistory.D1).side===-side || trend(btcHistory.H4).side===-side) return reject('Against BTC regime');
  }
  const bars=history.H1,last=bars.at(-1),prior=bars.slice(-21,-1),price=Number(market.price),a=h1.atr;
  const level=side===1?Math.max(...prior.map(r=>r[2])):Math.min(...prior.map(r=>r[3]));
  const breakout=side*(last[4]-level)>0 && side*(last[4]-last[1])>0;
  const volumeRatio=last[5]/mean(prior.map(r=>r[5]));
  if(!breakout || volumeRatio<1.2) return reject('No volume-confirmed H1 breakout');
  if(Math.abs(price-last[4])>a*.35 || side*(price-h1.fast)>a*3 || side*(price-level)<0) return reject('Entry extended or breakout invalidated');
  const structure=side===1?Math.min(...bars.slice(-6).map(r=>r[3])):Math.max(...bars.slice(-6).map(r=>r[2]));
  const stop=structure-side*a*.2,risk=side*(price-stop),riskPct=risk/price;
  if(riskPct<.004 || riskPct>.05 || risk<a*1.2) return reject('Structural stop outside risk bounds');
  const direction=side===1?'LONG':'SHORT',targets=[1,2,3].map(r=>price+side*risk*r);
  if(targets.some(t=>t<=0)||stop<=0) return reject('Invalid price levels');
  const pnl=scenarios(price,stop,targets,direction);
  if(pnl.targets[1].netBeforeFundingUsd / Math.abs(pnl.stop.netBeforeFundingUsd)<1.6) return reject('Net reward/risk too low');
  const score=Math.min(100,75+Math.min(10,(volumeRatio-1.2)*10)+Math.min(8,Math.abs(h4.fast-h4.slow)/h4.atr*3)+Math.min(7,Math.max(0,market.oiChange)*100));
  if(score<80) return reject('Quality score below 80/100');
  return {eligible:true,symbol,model:MODEL,direction,score:Math.round(score),entry:price,entryZone:[price-a*.15,price+a*.15],stop,targets,riskPct,pnl,expectedPnlUsd:null,probability:null,horizonHours:48,entryValidUntil:now+3_600_000,candleAt:last[0],reason:'D1/H4 trend + H1 breakout + volume + liquidity + derivatives',analysis:{d1:side===1?'UP':'DOWN',h4:side===1?'UP':'DOWN',h1:side===1?'UP':'DOWN',volumeRatio,atr:a,spreadBps:market.spreadBps,fundingRate:market.fundingRate,oiChange:market.oiChange,bookAt:market.bookAt,tradeAt:market.tradeAt},researchStatus:'RULE_BASED_UNVALIDATED'};
}
export function selectSetups(candidates, signals, now) {
  const today=signals.filter(s=>reviewDay(s.createdAt)===reviewDay(now));
  const blocked=new Set([...today,...signals.filter(s=>s.entryValidUntil>now)].map(s=>s.symbol));
  const recent=signals.some(s=>now-s.createdAt<3_600_000);
  if(recent) return [];
  return candidates.filter(c=>c.eligible&&!blocked.has(c.symbol)).sort((a,b)=>b.score-a.score || a.symbol.localeCompare(b.symbol)).slice(0,Math.max(0,Math.min(2,DAILY_CAP-today.length))).map(c=>({...c,id:`${MODEL}:${c.symbol}:${c.candleAt}:${c.direction}`,createdAt:now,status:'OPEN',day:reviewDay(now)}));
}
// Conservative candle model: partial entry candle cannot establish intrabar order.
// Any gap/ambiguous entry invalidates evidence; never counted as a win.
export function advancePaper(signal, rawBars, now) {
  if(signal.status!=='OPEN') return signal;
  const bars=closedCandles(rawBars,60_000,now),deadline=signal.createdAt+signal.horizonHours*3_600_000;
  const next={...signal};let cursor=signal.paperCursor;
  for(const b of bars.filter(b=>b[0]>=cursor && b[0]+60_000<=deadline)) {
    if(b[0]!==cursor) return {...next,status:'INVALID_EVIDENCE',outcomeReason:'Missing minute candles'};
    const side=signal.direction==='LONG'?1:-1,stopHit=side===1?b[3]<=signal.stop:b[2]>=signal.stop,targetHit=side===1?b[2]>=signal.targets[2]:b[3]<=signal.targets[2];
    if(b[0]<signal.createdAt && (stopHit||targetHit)) return {...next,status:'INVALID_EVIDENCE',outcomeReason:'Entry-minute ordering unknown'};
    if(stopHit||targetHit) {
      const stopFill=side===1?Math.min(b[1],signal.stop):Math.max(b[1],signal.stop);
      const exit=stopHit?stopFill:signal.targets[2];
      return {...next,status:'CLOSED',exit,closedAt:b[0]+60_000,outcomeReason:stopHit?'STOP':'TP3',ambiguous:stopHit&&targetHit,netBeforeFundingUsd:scenarios(signal.entry,exit,[],signal.direction).stop.netBeforeFundingUsd,fundingIncluded:false,evidence:'conservative_1m_candle_v1'};
    }
    cursor=b[0]+60_000;next.paperCursor=cursor;next.lastPaperClose=b[4];
  }
  if(now>=deadline && cursor>=Math.floor(deadline/60_000)*60_000) return {...next,status:'CLOSED',exit:next.lastPaperClose,closedAt:cursor,outcomeReason:'TIMEOUT',netBeforeFundingUsd:scenarios(signal.entry,next.lastPaperClose,[],signal.direction).stop.netBeforeFundingUsd,fundingIncluded:false,evidence:'conservative_1m_candle_v1'};
  if(now-cursor>1_000*60_000) return {...next,status:'INVALID_EVIDENCE',outcomeReason:'Recovery exceeds retained minute page'};
  return next;
}
