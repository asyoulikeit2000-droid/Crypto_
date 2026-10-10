// Public price corroboration only; no exchange credentials or order APIs.
export const VENUE_URL='https://www.okx.com/api/v5/market/tickers?instType=SWAP';
export function parseVenueTickers(value,now=Date.now()) {
  if(value?.code!=='0'||!Array.isArray(value.data))throw Error('OKX public ticker response unavailable');
  const markets={};
  for(const row of value.data){
    const match=/^([A-Z0-9]+)-USDT-SWAP$/.exec(row.instId||'');
    const price=Number(row.last),at=Number(row.ts);
    if(!match||!(price>0)||!Number.isFinite(price)||!(at>0)||at>now+5000||now-at>90000)continue;
    const symbol=match[1]+'USDT';
    // Exact base-token match only; no guessed multiplier or token aliases.
    if(markets[symbol])throw Error('Ambiguous OKX instrument mapping');
    markets[symbol]={source:'OKX',instrument:row.instId,price,at};
  }
  if(!Object.keys(markets).length)throw Error('OKX public prices stale or unavailable');
  return markets;
}
export function venueGate(candidate,market,value,now=Date.now()) {
  if(!candidate.eligible)return candidate;
  const reject=reason=>({...candidate,eligible:false,reason});
  const quote=value?.markets?.[candidate.symbol];
  if(!value?.available||!quote||![value.fetchedAt,quote.at].every(t=>Number.isFinite(t)&&t>0)||now-value.fetchedAt>90000||value.fetchedAt>now+5000||now-quote.at>90000||quote.at>now+5000)return reject('Fresh matching OKX perpetual price unavailable');
  const price=Number(market?.price),other=Number(quote.price);
  if(!(price>0&&other>0)||![price,other].every(Number.isFinite))return reject('Cross-venue price evidence invalid');
  const deviationBps=Math.abs(price-other)/other*10000;
  if(deviationBps>50)return reject('Bybit/OKX price disagreement exceeds 0.5%');
  return {...candidate,venue:{...quote,fetchedAt:value.fetchedAt,deviationBps,maxDeviationBps:50},reason:candidate.reason+'; matching OKX price corroborated'};
}
export function createVenueContext(fetcher=fetch,clock=Date.now){
  let value={available:false,markets:{},fetchedAt:null,reason:'Loading OKX public prices'},lastAttempt=0,busy=false;
  return {status:()=>structuredClone(value),async refresh(){
    if(busy||lastAttempt&&clock()-lastAttempt<60000)return;busy=true;lastAttempt=clock();
    try{const r=await fetcher(VENUE_URL,{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('OKX public ticker HTTP '+r.status);const markets=parseVenueTickers(await r.json(),clock());value={available:true,markets,fetchedAt:clock(),reason:null};}
    catch{value={available:false,markets:{},fetchedAt:null,reason:'OKX public prices unavailable; cross-venue signals blocked'};}
    finally{busy=false;}
  }};
}
