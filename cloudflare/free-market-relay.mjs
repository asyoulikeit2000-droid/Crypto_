// Read-only, bounded public-market relay. Separate worker; shared bot relay unchanged.
const ROOT='https://api.bybit.com';
const oiCache=new Map();
async function interest(symbol){const old=oiCache.get(symbol);if(old&&Date.now()-old.at<300000)return old.value;const value=(await get(`/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=13`)).list;oiCache.set(symbol,{at:Date.now(),value});if(oiCache.size>100)oiCache.delete(oiCache.keys().next().value);return value;}
async function boundedMap(rows,fn){const out=[];for(let i=0;i<rows.length;i+=3){out.push(...await Promise.all(rows.slice(i,i+3).map(fn)));if(i+3<rows.length)await new Promise(r=>setTimeout(r,150));}return out;}
async function get(path) {
  const response=await fetch(ROOT+path,{signal:AbortSignal.timeout(12000)});
  if(!response.ok) throw new Error('Bybit HTTP '+response.status);
  const data=await response.json();
  if(data.retCode!==0) throw new Error('Bybit '+data.retCode);
  return data.result;
}
export default {async fetch(request) {
  try {
    if(request.method!=='GET') return Response.json({ok:false},{status:405});
    const u=new URL(request.url),mode=u.searchParams.get('mode');
    if(u.pathname==='/health') return Response.json({ok:true,service:'crypto-engine-free-market'});
    const symbols=[...new Set((u.searchParams.get('symbols')||'').split(','))].filter(s=>/^[A-Z0-9]{2,20}USDT$/.test(s)).slice(0,12);
    if(mode==='bootstrap') {
      const [info,tickers]=await Promise.all([get('/v5/market/instruments-info?category=linear&status=Trading&limit=1000'),get('/v5/market/tickers?category=linear')]);
      return Response.json({ok:true,info:info.list,tickers:tickers.list,generatedAt:Date.now()});
    }
    if(!symbols.length) return Response.json({ok:false,error:'symbols_required'},{status:400});
    if(mode==='history') {
      const symbol=symbols[0];
      const rows=await Promise.all(['60','240','D'].map(async interval=>[interval,(await get(`/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=221`)).list]));
      
      return Response.json({ok:true,symbol,histories:{H1:rows[0][1],H4:rows[1][1],D1:rows[2][1]},generatedAt:Date.now()});
    }
    if(mode==='paper') {
      const symbol=symbols[0],start=Number(u.searchParams.get('start'));
      if(!Number.isSafeInteger(start)||start<0||start>Date.now()) return Response.json({ok:false,error:'invalid_start'},{status:400});
      const result=await get(`/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${start}&end=${Math.min(Date.now(),start+999*60000)}&limit=1000`);
      return Response.json({ok:true,bars:result.list,generatedAt:Date.now()});
    }
    if(mode!=='snapshot') return Response.json({ok:false,error:'unknown_mode'},{status:400});
    const tickers=(await get('/v5/market/tickers?category=linear')).list.filter(t=>symbols.includes(t.symbol));
    const results=await boundedMap(symbols,async symbol=>{
      try {
        const [book,trades,oi]=await Promise.all([get(`/v5/market/orderbook?category=linear&symbol=${symbol}&limit=5`),get(`/v5/market/recent-trade?category=linear&symbol=${symbol}&limit=1`),interest(symbol)]);
        return {symbol,book,trades:trades.list,oi};
      } catch(e) {return {symbol,error:String(e.message)};}
    });
    return Response.json({ok:true,tickers,results,generatedAt:Date.now()},{headers:{'cache-control':'no-store'}});
  } catch(e) {return Response.json({ok:false,error:String(e.message)},{status:502});}
}};
