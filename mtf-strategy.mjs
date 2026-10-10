export const MODEL = 'mtf_free_tiers_v3';
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
export function rsi(values,period=14){
  if(values.length<period+1||!values.every(Number.isFinite))return null;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const delta=values[i]-values[i-1];gain+=Math.max(0,delta)/period;loss+=Math.max(0,-delta)/period;}
  for(let i=period+1;i<values.length;i++){const delta=values[i]-values[i-1];gain=(gain*(period-1)+Math.max(0,delta))/period;loss=(loss*(period-1)+Math.max(0,-delta))/period;}
  return gain===0&&loss===0?50:loss===0?100:100-100/(1+gain/loss);
}
function atr(bars) { return mean(bars.slice(-14).map((r,i)=>{const prev=bars[bars.length-14+i-1][4];return Math.max(r[2]-r[3],Math.abs(r[2]-prev),Math.abs(r[3]-prev));})); }
function trend(bars) {
  const c=bars.map(r=>r[4]), fast=ema(c,20), slow=ema(c,50), prior=ema(c.slice(0,-3),20);
  return {side:c.at(-1)>fast && fast>slow && fast>prior?1:c.at(-1)<fast && fast<slow && fast<prior?-1:0,fast,slow,atr:atr(bars)};
}
export function technicalSnapshot(history,now){
 return Object.fromEntries(Object.keys(INTERVALS).map(tf=>{
  const bars=history?.[tf];if(!candleCoverage(bars,tf,now))return [tf,{available:false,reason:'Need 200+ continuous, current closed candles'}];
  const t=trend(bars);return [tf,{available:true,closedAt:bars.at(-1)[0],close:bars.at(-1)[4],trend:t.side===1?'UP':t.side===-1?'DOWN':'NEUTRAL',ema20:t.fast,ema50:t.slow,rsi14:rsi(bars.map(r=>r[4])),atr14:t.atr}];
 }));
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
export function exactLevels(entry,stop,targets,direction,tickSize) {
  const tick=Number(tickSize);if(!finite(tickSize)||tick<=0||tick>entry*.01)throw Error('Exchange tick size unavailable or invalid');
  const decimals=Math.min(12,Math.max(0,Math.ceil(-Math.log10(tick))+2));
  const round=(v,up)=>Number(((up?Math.ceil(v/tick-1e-9):Math.floor(v/tick+1e-9))*tick).toFixed(decimals));
  const long=direction==='LONG',e=round(entry,long),s=round(stop,!long),t=targets.map(x=>round(x,!long));
  const side=long?1:-1,risk=side*(e-s);
  if(!(e>0&&s>0&&risk>0)||t.some((x,i)=>x<=0||side*(x-e)<=0||i&&side*(x-t[i-1])<=0))throw Error('Rounded price levels invalid');
  return {entry:e,stop:s,targets:t,tickSize:String(tickSize),riskPct:risk/e};
}
export function evaluateMtf(symbol, history, market, btcHistory, now) {
  const indicators=technicalSnapshot(history,now);
  const reject=reason=>({symbol,eligible:false,reason,analysis:{indicators}});
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
  const previous=bars.at(-2),pullback=side*(last[4]-last[1])>0&&side*(last[4]-previous[4])>0&&Math.abs(last[4]-h1.fast)<=a&&bars.slice(-3).some(r=>r[3]<=h1.fast&&r[2]>=h1.fast)&&side*(last[4]-h1.fast)>0;
  if((!breakout&&!pullback)||volumeRatio<1.2) return reject('No volume-confirmed H1 breakout or trend pullback');
  const strategy=breakout?'TREND_BREAKOUT':'TREND_PULLBACK';
  if(Math.abs(price-last[4])>a*.35 || side*(price-h1.fast)>a*3 || breakout&&side*(price-level)<0) return reject('Entry extended or trigger invalidated');
  const structure=side===1?Math.min(...bars.slice(-6).map(r=>r[3])):Math.max(...bars.slice(-6).map(r=>r[2]));
  const stop=structure-side*a*.2,risk=side*(price-stop),riskPct=risk/price;
  if(riskPct<.004 || riskPct>.05 || risk<a*1.2) return reject('Structural stop outside risk bounds');
  const direction=side===1?'LONG':'SHORT';let exact;
  try{exact=exactLevels(price,stop,[1,2,3].map(r=>price+side*risk*r),direction,market.tickSize);}catch(e){return reject(e.message);}
  const targets=exact.targets;
  if(targets.some(t=>t<=0)||stop<=0) return reject('Invalid price levels');
  if(exact.riskPct<.004||exact.riskPct>.05)return reject('Rounded structural stop outside risk bounds');
  const pnl=scenarios(exact.entry,exact.stop,targets,direction);
  if(pnl.targets[1].netBeforeFundingUsd / Math.abs(pnl.stop.netBeforeFundingUsd)<1.6) return reject('Net reward/risk too low');
  const score=Math.min(100,75+Math.min(10,(volumeRatio-1.2)*10)+Math.min(8,Math.abs(h4.fast-h4.slow)/h4.atr*3)+Math.min(7,Math.max(0,market.oiChange)*100));
  if(score<80) return reject('Quality score below 80/100');
  const lower=Math.min(exact.stop,targets[0]),upper=Math.max(exact.stop,targets[0]);
  return {eligible:true,symbol,model:MODEL,strategy,direction,score:Math.round(score),...exact,entryZone:[Math.max(lower,exact.entry-a*.15),Math.min(upper,exact.entry+a*.15)],pnl,expectedPnlUsd:null,probability:null,horizonHours:48,entryValidUntil:now+3_600_000,candleAt:last[0],reason:'D1/H4 trend + H1 '+strategy.toLowerCase().replace('trend_','')+' + volume + liquidity + derivatives',analysis:{indicators,atrPct:a/price*100,netRewardRisk:pnl.targets[1].netBeforeFundingUsd/Math.abs(pnl.stop.netBeforeFundingUsd),triggerLevel:breakout?level:h1.fast,triggerAt:last[0],d1:side===1?'UP':'DOWN',h4:side===1?'UP':'DOWN',h1:side===1?'UP':'DOWN',volumeRatio,atr:a,spreadBps:market.spreadBps,fundingRate:market.fundingRate,oiChange:market.oiChange,bookAt:market.bookAt,tradeAt:market.tradeAt},researchStatus:'RULE_BASED_UNVALIDATED'};
}
export function entryState(signal,market,now,ready) {
  if(signal.status!=='OPEN')return {actionable:false,reason:signal.invalidationReason||'Archived entry'};
  if(!ready)return {actionable:false,reason:'Feed, context or persistence unavailable'};
  if(now>=signal.entryValidUntil)return {actionable:false,reason:'Entry window expired'};
  if(!freshness(market,now).fresh)return {actionable:false,reason:'Market evidence stale'};
  if(!finite(market.price)||!signal.entryZone?.every(finite))return {actionable:false,reason:'Price evidence missing'};
  if(market.price<signal.entryZone[0]||market.price>signal.entryZone[1])return {actionable:false,reason:'Outside entry zone; do not chase'};
  return {actionable:true,reason:'Within entry zone; manual limit-entry review'};
}
export function invalidateEntry(signal,market,now) {
  if(signal.status!=='OPEN'||!freshness(market,now).fresh||!finite(market.price))return signal;
  const side=signal.direction==='LONG'?1:-1;
  if(side*(market.price-signal.stop)<=0||side*(market.price-signal.targets?.[0])>=0)return {...signal,status:'INVALIDATED',invalidatedAt:now,invalidationReason:'Observed stop or TP1 reached; entry cancelled (not a tracked trade outcome)'};
  return signal;
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
