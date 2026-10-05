import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { grtFramework, decideAction } from "./rescue-strategy.mjs";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const USER = process.env.RESCUE_USER || "owner";
const PASSWORD = process.env.RESCUE_PASSWORD || "";
const PUBLIC_DIR = fileURLToPath(new URL("./public-rescue/", import.meta.url));
const FUTURES = "https://fapi.binance.com";
const SPOT = "https://api.binance.com";
const DISCLAIMER = "Private research and risk-management dashboard only. No trade execution. No profit guarantee.";

function json(res,status,body){res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(body));}
function unauthorized(res){res.writeHead(401,{"www-authenticate":"Basic realm=\"Private Rescue Dashboard\"","content-type":"text/plain; charset=utf-8","cache-control":"no-store"});res.end("Authentication required");}
function authed(req){
  if(!PASSWORD)return false;
  const h=String(req.headers.authorization||"");
  if(!h.startsWith("Basic "))return false;
  try{const raw=Buffer.from(h.slice(6),"base64").toString("utf8");const i=raw.indexOf(":");return i>=0&&raw.slice(0,i)===USER&&raw.slice(i+1)===PASSWORD;}catch{return false;}
}
async function getJson(url){
  const r=await fetch(url,{headers:{"user-agent":"crypto-rescue-dashboard/2.0"},signal:AbortSignal.timeout(9000)});
  if(!r.ok)throw new Error("HTTP "+r.status+" "+url);
  return r.json();
}
async function getText(url){
  const r=await fetch(url,{headers:{"user-agent":"crypto-rescue-dashboard/2.0"},signal:AbortSignal.timeout(9000)});
  if(!r.ok)throw new Error("HTTP "+r.status+" "+url);
  return r.text();
}
function n(x,f=null){const v=Number(x);return Number.isFinite(v)?v:f;}
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
function pct(a,b){return b?((a/b)-1):0;}
function level(x,d=5){return Number.isFinite(x)?Number(x.toFixed(d)):null;}
function ema(vals,p){if(!vals.length)return null;const k=2/(p+1);let e=vals[0];for(let i=1;i<vals.length;i++)e=vals[i]*k+e*(1-k);return e;}
function rsi(vals,p=14){if(vals.length<p+1)return null;let g=0,l=0;for(let i=vals.length-p;i<vals.length;i++){const d=vals[i]-vals[i-1];if(d>0)g+=d;else l-=d;}if(l===0)return 100;const rs=(g/p)/(l/p);return 100-(100/(1+rs));}
function atr(k,p=14){if(k.length<p+1)return null;const t=[];for(let i=1;i<k.length;i++){const h=n(k[i][2],0),lo=n(k[i][3],0),pc=n(k[i-1][4],0);t.push(Math.max(h-lo,Math.abs(h-pc),Math.abs(lo-pc)));}return t.slice(-p).reduce((a,b)=>a+b,0)/p;}
function summarize(k){
  const c=k.map(x=>n(x[4],0)),h=k.map(x=>n(x[2],0)),l=k.map(x=>n(x[3],0)),v=k.map(x=>n(x[5],0));
  const closedIndex=Math.max(0,k.length-2);
  const prev20=v.slice(Math.max(0,closedIndex-20),closedIndex);
  const avgVol=prev20.length?prev20.reduce((a,b)=>a+b,0)/prev20.length:null;
  const closedVol=v[closedIndex]??null;
  return {
    last:c.at(-1),ema20:ema(c.slice(-60),20),ema50:ema(c.slice(-90),50),rsi14:rsi(c,14),atr14:atr(k,14),
    recentHigh:Math.max(...h.slice(-12)),recentLow:Math.min(...l.slice(-12)),prevClose:c.at(-2),
    return4:pct(c.at(-2),c.at(-6)),closedVolume:closedVol,volumeRatio:avgVol?closedVol/avgVol:null,
    lastClosed:k.at(-2)?{open:n(k.at(-2)[1]),high:n(k.at(-2)[2]),low:n(k.at(-2)[3]),close:n(k.at(-2)[4]),volume:n(k.at(-2)[5]),closeTime:n(k.at(-2)[6])}:null
  };
}
function decodeXml(s){return String(s||"").replace(/<!\[CDATA\[|\]\]>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">");}
function parseRss(xml,limit=12){
  const out=[];const re=/<item>([\s\S]*?)<\/item>/gi;let m;
  while((m=re.exec(xml))&&out.length<limit){
    const b=m[1];const pick=(tag)=>decodeXml((b.match(new RegExp("<"+tag+"[^>]*>([\\s\\S]*?)<\\/"+tag+">","i"))||[])[1]||"").trim();
    const title=pick("title"),link=pick("link"),pubDate=pick("pubDate"),source=pick("source");
    if(title)out.push({title,link,pubDate,source});
  }
  return out;
}
async function recentNews(symbol){
  const base=symbol.replace(/USDT$/,"");
  const name=base==="GRT"?"The Graph GRT":base+" crypto";
  const q1=encodeURIComponent(name+" when:7d");
  const q2=encodeURIComponent("site:thegraph.com/blog "+name+" when:30d");
  const urls=[
    "https://news.google.com/rss/search?q="+q1+"&hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/search?q="+q2+"&hl=en-US&gl=US&ceid=US:en"
  ];
  const settled=await Promise.allSettled(urls.map(getText));
  const items=[];
  for(const s of settled)if(s.status==="fulfilled")items.push(...parseRss(s.value));
  const seen=new Set();const dedup=[];
  for(const x of items){const k=x.title.toLowerCase();if(!seen.has(k)){seen.add(k);dedup.push(x);}}
  const positive=/launch|upgrade|integration|migration|adoption|growth|partnership|mainnet|network|staking|expansion/i;
  const negative=/hack|exploit|lawsuit|delay|outage|delist|investigation|breach/i;
  let score=0;
  for(const x of dedup.slice(0,10)){if(positive.test(x.title))score+=0.25;if(negative.test(x.title))score-=0.5;}
  return {available:dedup.length>0,provider:"Google News RSS aggregation",quality:"medium",score:clamp(score,-1.5,1.5),items:dedup.slice(0,8),officialMatches:dedup.filter(x=>/thegraph\.com/i.test(x.title+" "+x.source+" "+x.link)).length};
}
function regimeScore(price,s){
  if(!s)return 0;let x=0;if(price>s.ema20)x+=0.5;else x-=0.5;if(s.rsi14>52)x+=0.3;else if(s.rsi14<42)x-=0.3;return x;
}

async function analyze(params){
  const symbol=String(params.get("symbol")||"GRTUSDT").toUpperCase().replace(/[^A-Z0-9]/g,"");
  const entry=n(params.get("entry"),0.035),notional=Math.max(0,n(params.get("notional"),40000)),margin=Math.max(1,n(params.get("margin"),20000));
  const hedgeNotional=Math.max(0,n(params.get("hedgeNotional"),0));
  const direction=String(params.get("direction")||"long").toLowerCase()==="short"?"short":"long";

  const f=(p)=>FUTURES+p,s=(p)=>SPOT+p;
  const requests={
    price:getJson(f("/fapi/v2/ticker/price?symbol="+symbol)),
    premium:getJson(f("/fapi/v1/premiumIndex?symbol="+symbol)),
    h1:getJson(f("/fapi/v1/klines?symbol="+symbol+"&interval=1h&limit=120")),
    h4:getJson(f("/fapi/v1/klines?symbol="+symbol+"&interval=4h&limit=120")),
    d1:getJson(f("/fapi/v1/klines?symbol="+symbol+"&interval=1d&limit=90")),
    oi:getJson(f("/fapi/v1/openInterest?symbol="+symbol)),
    oiHist:getJson(f("/futures/data/openInterestHist?symbol="+symbol+"&period=1h&limit=24")),
    globalLS:getJson(f("/futures/data/globalLongShortAccountRatio?symbol="+symbol+"&period=1h&limit=24")),
    topPos:getJson(f("/futures/data/topLongShortPositionRatio?symbol="+symbol+"&period=1h&limit=24")),
    topAcct:getJson(f("/futures/data/topLongShortAccountRatio?symbol="+symbol+"&period=1h&limit=24")),
    taker:getJson(f("/futures/data/takerlongshortRatio?symbol="+symbol+"&period=1h&limit=24")),
    book:getJson(f("/fapi/v1/depth?symbol="+symbol+"&limit=100")),
    t24:getJson(f("/fapi/v1/ticker/24hr?symbol="+symbol)),
    spotPrice:getJson(s("/api/v3/ticker/price?symbol="+symbol)),
    spot24:getJson(s("/api/v3/ticker/24hr?symbol="+symbol)),
    btc24:getJson(f("/fapi/v1/ticker/24hr?symbol=BTCUSDT")),
    eth24:getJson(f("/fapi/v1/ticker/24hr?symbol=ETHUSDT")),
    btc4h:getJson(f("/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=80")),
    eth4h:getJson(f("/fapi/v1/klines?symbol=ETHUSDT&interval=4h&limit=80")),
    liquidations:getJson(f("/fapi/v1/allForceOrders?symbol="+symbol+"&limit=100")),
    news:recentNews(symbol)
  };
  const keys=Object.keys(requests),vals=await Promise.allSettled(Object.values(requests)),data={},unavailable=[];
  vals.forEach((r,i)=>{if(r.status==="fulfilled")data[keys[i]]=r.value;else unavailable.push(keys[i]);});

  const price=n(data.price?.price,n(data.premium?.markPrice,null)); if(!price)throw new Error("Live price unavailable for "+symbol);
  const mark=n(data.premium?.markPrice,price),index=n(data.premium?.indexPrice,null),funding=n(data.premium?.lastFundingRate,null);
  const h1=Array.isArray(data.h1)?summarize(data.h1):null,h4=Array.isArray(data.h4)?summarize(data.h4):null,d1=Array.isArray(data.d1)?summarize(data.d1):null;
  const btc4=Array.isArray(data.btc4h)?summarize(data.btc4h):null,eth4=Array.isArray(data.eth4h)?summarize(data.eth4h):null;
  const oiNow=n(data.oi?.openInterest,null),oiHist=Array.isArray(data.oiHist)?data.oiHist:[];
  const oiStart=n(oiHist[0]?.sumOpenInterest,null),oiEnd=n(oiHist.at(-1)?.sumOpenInterest,null),oi24=oiStart&&oiEnd?pct(oiEnd,oiStart):null;
  const globalLS=Array.isArray(data.globalLS)?data.globalLS.at(-1):null,topPos=Array.isArray(data.topPos)?data.topPos.at(-1):null,topAcct=Array.isArray(data.topAcct)?data.topAcct.at(-1):null,taker=Array.isArray(data.taker)?data.taker.at(-1):null;
  let bidNot=0,askNot=0;for(const row of data.book?.bids||[])bidNot+=n(row[0],0)*n(row[1],0);for(const row of data.book?.asks||[])askNot+=n(row[0],0)*n(row[1],0);
  const bookRatio=askNot>0?bidNot/askNot:null,takerRatio=n(taker?.buySellRatio,null),globalLong=n(globalLS?.longAccount,null),topLong=n(topPos?.longAccount,null),topAccountLong=n(topAcct?.longAccount,null);
  const change24=n(data.t24?.priceChangePercent,null),btcChange=n(data.btc24?.priceChangePercent,null),ethChange=n(data.eth24?.priceChangePercent,null);
  const spotPrice=n(data.spotPrice?.price,null),spotBasisBps=spotPrice?((mark/spotPrice)-1)*10000:null,spotChange=n(data.spot24?.priceChangePercent,null);
  const move=direction==="long"?pct(price,entry):pct(entry,price),pnl=notional*move,roe=pnl/margin,leverage=notional/margin;
  const fw=grtFramework(symbol,price,h1,h4,d1);

  const btcReg=regimeScore(n(data.btc24?.lastPrice,null),btc4),ethReg=regimeScore(n(data.eth24?.lastPrice,null),eth4),macroScore=btcReg+ethReg;
  const rel24=(change24!=null&&btcChange!=null&&ethChange!=null)?change24-(btcChange+ethChange)/2:null;
  const rel4=(h4?.return4!=null&&btc4?.return4!=null&&eth4?.return4!=null)?h4.return4-(btc4.return4+eth4.return4)/2:null;

  let liq={available:false,quality:"medium",longUsd:null,shortUsd:null,netBias:null};
  if(Array.isArray(data.liquidations)){let longUsd=0,shortUsd=0;for(const x of data.liquidations){const usd=n(x?.price,0)*n(x?.origQty||x?.executedQty,0);if(String(x?.side).toUpperCase()==="SELL")longUsd+=usd;else if(String(x?.side).toUpperCase()==="BUY")shortUsd+=usd;}liq={available:true,quality:"medium",longUsd,shortUsd,netBias:shortUsd-longUsd};}
  const adl={available:false,reason:"Binance ADL quantile is account-authenticated; this private dashboard uses public market endpoints only."};
  const onchain={available:false,reason:"No reliable keyless exchange-flow/on-chain provider is configured; omitted rather than guessed."};
  const news=data.news||{available:false,provider:null,quality:"unavailable",score:0,items:[]};

  let score=0;const evidence=[];function add(label,value,weight,quality,detail,source){score+=value*weight;evidence.push({label,value,weight,quality,detail,source});}
  if(h1){add("H1 trend",price>h1.ema20?1:-1,1.1,"strong","Price "+(price>h1.ema20?"above":"below")+" EMA20","Binance futures");add("H1 momentum",h1.rsi14>52?1:h1.rsi14<42?-1:0,0.7,"strong","RSI "+h1.rsi14.toFixed(1),"Binance futures");}
  if(h4){add("H4 trend",price>h4.ema20?1:-1,1.5,"strong","Price "+(price>h4.ema20?"above":"below")+" EMA20","Binance futures");if(h4.volumeRatio!=null)add("4H volume",h4.volumeRatio>1.35?1:h4.volumeRatio<0.7?-0.5:0,0.7,"strong",h4.volumeRatio.toFixed(2)+"× 20-candle average","Binance futures");}
  if(d1)add("D1 structure",price>d1.ema20?1:-1,1.2,"strong","Price "+(price>d1.ema20?"above":"below")+" EMA20","Binance futures");
  if(oi24!=null)add("OI regime",oi24<-.01?0.25:oi24>.04?-0.4:0,0.7,"medium","24h OI "+(oi24*100).toFixed(2)+"%","Binance futures");
  if(takerRatio!=null)add("Taker flow",takerRatio>1.12?1:takerRatio<0.88?-1:0,1.0,"medium","Buy/sell "+takerRatio.toFixed(2),"Binance futures");
  if(funding!=null)add("Funding",Math.abs(funding)<0.0002?0.25:funding>0.0005?-0.5:0,0.45,"medium",(funding*100).toFixed(4)+"%","Binance futures");
  if(topLong!=null)add("Top traders",topLong>0.7?-0.5:topLong>0.58?-0.15:0,0.65,"medium",(topLong*100).toFixed(1)+"% long","Binance futures");
  if(bookRatio!=null)add("Order book",bookRatio>1.18?0.5:bookRatio<0.82?-0.5:0,0.3,"weak","Bid/ask notional "+bookRatio.toFixed(2),"Binance futures");
  if(spotBasisBps!=null)add("Spot/perp basis",Math.abs(spotBasisBps)<8?0.25:spotBasisBps>20?-0.5:0,0.45,"medium",spotBasisBps.toFixed(1)+" bps","Binance spot + futures");
  add("BTC/ETH regime",macroScore>0.8?1:macroScore<-.8?-1:0,0.9,"strong","Macro score "+macroScore.toFixed(2),"Binance BTC/ETH futures");
  if(rel24!=null)add("GRT relative strength",rel24>1.5?1:rel24<-1.5?-1:0,0.7,"strong","24h vs BTC/ETH "+rel24.toFixed(2)+" pts","Binance futures");
  if(news.available)add("Recent catalysts",news.score>0.4?1:news.score<-.4?-1:0,0.45,"medium",news.items.length+" recent items; score "+news.score.toFixed(2),news.provider);

  const h1Close=h1?.lastClosed?.close,h4Close=h4?.lastClosed?.close;
  const decided=decideAction({direction,price,entry,hedgeNotional,h1Close,h4Close,score,framework:fw});
  const action=decided.action,secondary=decided.secondaryAction;
  const profitablePath=score>=1.7?"IMPROVING":score<=-1.8?"DETERIORATING":"REALISTIC BUT UNCONFIRMED";
  const confidence=clamp(50+score*7,20,86);
  const recoveryNeed=direction==="long"?pct(entry,price):pct(price,entry);
  const profitPlan={
    entryZone:entry,
    partialProfitZone:symbol==="GRTUSDT"?[0.0350,0.0360]:[entry,level(entry*1.03,6)],
    extensionTrigger:symbol==="GRTUSDT"?0.0367:level(entry*1.05,6),
    guidance:"At breakeven/profit zone, de-risk part of the position. Keep a runner only if spot participation, taker flow, OI quality and broader regime remain supportive."
  };
  const scenarios={
    bearish:{status:(h1Close!=null&&h1Close<fw.hedgeTrigger)?"ACTIVE":"NOT CONFIRMED",next:"H1 close < "+fw.hedgeTrigger+" -> ~25% hedge. 4H close < "+fw.hard4h+" -> ~50% hedge. 4H close < "+fw.reduceTrigger+" -> reduce 20-25% of original long."},
    base:{status:price>=fw.resistance1?"PROGRESSING":"WAITING",next:"Hold recovered structure, then confirm "+fw.resistance2+". Above "+fw.resistance3+" the route toward "+entry+" becomes materially stronger."},
    bullish:{status:score>=2.5?"EMERGING":"UNCONFIRMED",next:"Sustain above "+fw.resistance3+" with healthy flow/OI and supportive BTC/ETH. At "+entry+"-"+profitPlan.partialProfitZone[1]+" de-risk part; above "+profitPlan.extensionTrigger+" keep only a runner if evidence remains strong."}
  };
  return {
    generatedAt:new Date().toISOString(),symbol,direction,entry,notional,margin,hedgeNotional,leverage,
    market:{price,mark,index,spotPrice,spotBasisBps,funding,change24,spotChange,openInterest:oiNow,oiChange24h:oi24,globalLong,topLong,topAccountLong,takerRatio,bookRatio},
    broader:{btc:{price:n(data.btc24?.lastPrice,null),change24:btcChange,regime:btcReg},eth:{price:n(data.eth24?.lastPrice,null),change24:ethChange,regime:ethReg},macroScore,relative24:rel24,relative4h:rel4},
    timeframes:{h1,h4,d1},
    position:{pnlPct:move,pnlUsdt:pnl,roe,recoveryNeededPct:recoveryNeed},
    decision:{action,secondaryAction:secondary,score:Number(score.toFixed(2)),confidence:Number(confidence.toFixed(0)),profitability:profitablePath,...fw,summary:action==="HOLD"?"Hold existing position; do not add. Wait for completed-close confirmation.":action==="EXIT-HEDGE"?"Recovery has confirmed enough to remove defensive hedge while retaining the core long.":action==="HEDGE"?"Defensive hedge trigger confirmed on a completed candle close.":action==="REDUCE"?(price>=entry?"De-risk recovered capital / partial profit rather than re-expose the full rescued position.":"Capital-preservation reduction trigger confirmed."):"No change."},
    scenarios,profitPlan,evidence,liquidations:liq,adl,onchain,news,unavailable,disclaimer:DISCLAIMER
  };
}

async function serveStatic(pathname,res){
  const rel=pathname==="/"? "index.html":pathname.replace(/^\//,"");const safe=normalize(rel).replace(/^\.\.(?:[\\/]|$)/g,"");const file=join(PUBLIC_DIR,safe);
  try{const body=await readFile(file);const ext=extname(file);const types={".html":"text/html; charset=utf-8",".js":"application/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};res.writeHead(200,{"content-type":types[ext]||"application/octet-stream","cache-control":"no-store","x-frame-options":"DENY","referrer-policy":"no-referrer","content-security-policy":"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'"});res.end(body);}catch{json(res,404,{error:"not_found"});}
}
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||"/","http://"+(req.headers.host||"localhost"));
    if(req.method==="GET"&&url.pathname==="/healthz")return json(res,200,{ok:true,paperOnly:true,executionEnabled:false,time:new Date().toISOString()});
    if(!authed(req))return unauthorized(res);
    if(req.method==="GET"&&url.pathname==="/api/analyze")return json(res,200,await analyze(url.searchParams));
    if(req.method==="GET"&&url.pathname==="/api/health")return json(res,200,{ok:true,paperOnly:true,executionEnabled:false,version:"rescue-v3",time:new Date().toISOString()});
    if(req.method==="GET")return serveStatic(url.pathname,res);
    return json(res,405,{error:"method_not_allowed"});
  }catch(e){return json(res,502,{error:String(e?.message||e),paperOnly:true});}
});
server.listen(PORT,HOST,()=>console.log(JSON.stringify({event:"rescue_dashboard_ready",version:"v3",host:HOST,port:PORT,paperOnly:true,executionEnabled:false})));
