// private rescue dashboard build v2
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const USER = process.env.RESCUE_USER || "owner";
const PASSWORD = process.env.RESCUE_PASSWORD || "";
const PUBLIC_DIR = fileURLToPath(new URL("./public-rescue/", import.meta.url));
const BINANCE = "https://fapi.binance.com";
const DISCLAIMER = "Research and risk-management dashboard only. No trade execution. No profit guarantee.";

function json(res,status,body){res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});res.end(JSON.stringify(body));}
function unauthorized(res){res.writeHead(401,{"www-authenticate":"Basic realm=\"Private Rescue Dashboard\"","content-type":"text/plain; charset=utf-8"});res.end("Authentication required");}
function authed(req){
  if(!PASSWORD) return false;
  const h=String(req.headers.authorization||"");
  if(!h.startsWith("Basic ")) return false;
  try{
    const raw=Buffer.from(h.slice(6),"base64").toString("utf8");
    const i=raw.indexOf(":");
    return i>=0 && raw.slice(0,i)===USER && raw.slice(i+1)===PASSWORD;
  }catch{return false;}
}
async function getJson(path){
  const r=await fetch(BINANCE+path,{headers:{"user-agent":"crypto-rescue-dashboard/1.0"},signal:AbortSignal.timeout(9000)});
  if(!r.ok) throw new Error("Binance "+r.status+" for "+path);
  return r.json();
}
function n(x,f=null){const v=Number(x);return Number.isFinite(v)?v:f;}
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
function ema(vals,p){if(!vals.length)return null;const k=2/(p+1);let e=vals[0];for(let i=1;i<vals.length;i++)e=vals[i]*k+e*(1-k);return e;}
function rsi(vals,p=14){
  if(vals.length<p+1)return null;let g=0,l=0;
  for(let i=vals.length-p;i<vals.length;i++){const d=vals[i]-vals[i-1];if(d>0)g+=d;else l-=d;}
  if(l===0)return 100;const rs=(g/p)/(l/p);return 100-(100/(1+rs));
}
function atr(k,p=14){
  if(k.length<p+1)return null;const t=[];
  for(let i=1;i<k.length;i++){const h=n(k[i][2],0),lo=n(k[i][3],0),pc=n(k[i-1][4],0);t.push(Math.max(h-lo,Math.abs(h-pc),Math.abs(lo-pc)));}
  return t.slice(-p).reduce((a,b)=>a+b,0)/p;
}
function summarize(k){
  const c=k.map(x=>n(x[4],0)), h=k.map(x=>n(x[2],0)), l=k.map(x=>n(x[3],0));
  const last=c.at(-1);
  return {
    last,
    ema20:ema(c.slice(-60),20),
    ema50:ema(c.slice(-90),50),
    rsi14:rsi(c,14),
    atr14:atr(k,14),
    recentHigh:Math.max(...h.slice(-12)),
    recentLow:Math.min(...l.slice(-12)),
    prevClose:c.at(-2),
    lastClosed:k.at(-2)?{open:n(k.at(-2)[1]),high:n(k.at(-2)[2]),low:n(k.at(-2)[3]),close:n(k.at(-2)[4]),volume:n(k.at(-2)[5])}:null
  };
}
function pct(a,b){return b?((a/b)-1):0;}
function level(x,d=5){return Number.isFinite(x)?Number(x.toFixed(d)):null;}

async function analyze(params){
  const symbol=String(params.get("symbol")||"GRTUSDT").toUpperCase().replace(/[^A-Z0-9]/g,"");
  const entry=n(params.get("entry"),0.035);
  const notional=Math.max(0,n(params.get("notional"),40000));
  const margin=Math.max(1,n(params.get("margin"),20000));
  const direction=String(params.get("direction")||"long").toLowerCase()==="short"?"short":"long";

  const paths=[
    "/fapi/v2/ticker/price?symbol="+symbol,
    "/fapi/v1/premiumIndex?symbol="+symbol,
    "/fapi/v1/klines?symbol="+symbol+"&interval=1h&limit=120",
    "/fapi/v1/klines?symbol="+symbol+"&interval=4h&limit=120",
    "/fapi/v1/klines?symbol="+symbol+"&interval=1d&limit=90",
    "/fapi/v1/openInterest?symbol="+symbol,
    "/futures/data/openInterestHist?symbol="+symbol+"&period=1h&limit=24",
    "/futures/data/globalLongShortAccountRatio?symbol="+symbol+"&period=1h&limit=24",
    "/futures/data/topLongShortPositionRatio?symbol="+symbol+"&period=1h&limit=24",
    "/futures/data/takerlongshortRatio?symbol="+symbol+"&period=1h&limit=24",
    "/fapi/v1/depth?symbol="+symbol+"&limit=100",
    "/fapi/v1/ticker/24hr?symbol="+symbol
  ];
  const settled=await Promise.allSettled(paths.map(getJson));
  const data=settled.map(x=>x.status==="fulfilled"?x.value:null);
  const unavailable=paths.filter((_,i)=>data[i]==null);

  const price=n(data[0]?.price,n(data[1]?.markPrice,null));
  if(!price) throw new Error("Live price unavailable for "+symbol);
  const mark=n(data[1]?.markPrice,price), index=n(data[1]?.indexPrice,null), funding=n(data[1]?.lastFundingRate,null);
  const h1=Array.isArray(data[2])?summarize(data[2]):null;
  const h4=Array.isArray(data[3])?summarize(data[3]):null;
  const d1=Array.isArray(data[4])?summarize(data[4]):null;
  const oiNow=n(data[5]?.openInterest,null);
  const oiHist=Array.isArray(data[6])?data[6]:[];
  const oiStart=n(oiHist[0]?.sumOpenInterest,null), oiEnd=n(oiHist.at(-1)?.sumOpenInterest,null);
  const oi24=oiStart&&oiEnd?pct(oiEnd,oiStart):null;
  const ls=Array.isArray(data[7])?data[7].at(-1):null;
  const top=Array.isArray(data[8])?data[8].at(-1):null;
  const taker=Array.isArray(data[9])?data[9].at(-1):null;
  const book=data[10]||{};
  const t24=data[11]||{};

  let bidNot=0,askNot=0;
  for(const row of book.bids||[]) bidNot+=n(row[0],0)*n(row[1],0);
  for(const row of book.asks||[]) askNot+=n(row[0],0)*n(row[1],0);
  const bookRatio=askNot>0?bidNot/askNot:null;
  const takerRatio=n(taker?.buySellRatio,null);
  const globalLong=n(ls?.longAccount,null);
  const topLong=n(top?.longAccount,null);
  const change24=n(t24?.priceChangePercent,null);

  const move=direction==="long"?pct(price,entry):pct(entry,price);
  const pnl=notional*move;
  const roe=pnl/margin;
  const leverage=notional/margin;

  const recentSupport=h1?Math.min(h1.recentLow,h4?.recentLow??h1.recentLow):price*0.97;
  const atr1=h1?.atr14||price*0.01;
  const hedgeTrigger=level(Math.max(recentSupport-0.15*atr1,price-1.6*atr1),5);
  const hard4h=level(Math.min(h4?.recentLow??recentSupport,recentSupport)-0.75*(h4?.atr14||atr1*3),5);
  const reduceTrigger=level(hard4h-0.75*(h4?.atr14||atr1*3),5);
  const r1=level(Math.max(h1?.ema20||price,h1?.recentHigh||price),5);
  const r2=level(Math.max(h4?.ema20||r1,h4?.recentHigh||r1),5);
  const r3=level(Math.max(d1?.ema20||r2,r2*1.035),5);

  let score=0;
  const evidence=[];
  function add(label,value,weight,quality,detail){score+=value*weight;evidence.push({label,value,weight,quality,detail});}
  if(h1){
    add("H1 trend",price>h1.ema20?1:-1,1.2,"strong","Price "+(price>h1.ema20?"above":"below")+" EMA20");
    add("H1 momentum",h1.rsi14>52?1:h1.rsi14<42?-1:0,0.8,"strong","RSI "+h1.rsi14.toFixed(1));
  }
  if(h4)add("H4 trend",price>h4.ema20?1:-1,1.5,"strong","Price "+(price>h4.ema20?"above":"below")+" EMA20");
  if(d1)add("D1 structure",price>d1.ema20?1:-1,1.4,"strong","Price "+(price>d1.ema20?"above":"below")+" EMA20");
  if(oi24!=null)add("OI regime",oi24<-.01?0.5:oi24>.04?-0.5:0,0.8,"medium","24h OI "+(oi24*100).toFixed(2)+"%");
  if(takerRatio!=null)add("Taker flow",takerRatio>1.12?1:takerRatio<0.88?-1:0,1.2,"medium","Buy/sell "+takerRatio.toFixed(2));
  if(funding!=null)add("Funding",Math.abs(funding)<0.0002?0.25:funding>0.0005?-0.5:0,0.5,"medium",(funding*100).toFixed(4)+"%");
  if(topLong!=null)add("Top traders",topLong>0.6?0.5:topLong<0.45?-0.5:0,0.5,"weak",(topLong*100).toFixed(1)+"% long");
  if(bookRatio!=null)add("Order book",bookRatio>1.18?0.5:bookRatio<0.82?-0.5:0,0.35,"weak","Bid/ask notional "+bookRatio.toFixed(2));
  if(change24!=null)add("24h relative impulse",change24>2?0.5:change24<-2?-0.5:0,0.4,"medium",change24.toFixed(2)+"%");

  let action="HOLD";
  if(direction==="long"){
    if(h1?.lastClosed?.close<hedgeTrigger) action="HEDGE";
    if(h4?.lastClosed?.close<hard4h) action="HEDGE";
    if(h4?.lastClosed?.close<reduceTrigger) action="REDUCE";
  }
  if(action==="HOLD" && score<-2.2) action="HOLD";
  const recoveryNeed=direction==="long"?pct(entry,price):pct(price,entry);
  const profitablePath = score>=1.5?"IMPROVING":score<=-2?"DETERIORATING":"REALISTIC BUT UNCONFIRMED";
  const confidence=clamp(50+score*8,20,85);

  const scenarios={
    bearish:{
      status:(h1?.lastClosed?.close<hedgeTrigger)?"ACTIVE":"NOT CONFIRMED",
      next:"Completed H1 close below "+hedgeTrigger+" -> hedge 25%; completed 4H below "+hard4h+" -> hedge ~50%; completed 4H below "+reduceTrigger+" -> reduce 20-25%."
    },
    base:{
      status:price>=r1?"PROGRESSING":"WAITING",
      next:"Hold support, reclaim "+r1+" then "+r2+". Acceptance above "+r2+" materially improves the route toward entry."
    },
    bullish:{
      status:score>=2.8?"EMERGING":"UNCONFIRMED",
      next:"Above "+r3+" with buyer-dominant flow and controlled OI/funding, keep a runner toward entry/profit rather than assuming breakeven is the ceiling."
    }
  };

  return {
    generatedAt:new Date().toISOString(),symbol,direction,entry,notional,margin,leverage,
    market:{price,mark,index,funding,change24,openInterest:oiNow,oiChange24h:oi24,globalLong,topLong,takerRatio,bookRatio},
    timeframes:{h1,h4,d1},
    position:{pnlPct:move,pnlUsdt:pnl,roe,recoveryNeededPct:recoveryNeed},
    decision:{
      action,score:Number(score.toFixed(2)),confidence:Number(confidence.toFixed(0)),profitability:profitablePath,
      hedgeTrigger,hard4h,reduceTrigger,resistance1:r1,resistance2:r2,resistance3:r3,
      summary:action==="HOLD"?"Hold existing position; add nothing; wait for confirmed close triggers.":action==="HEDGE"?"Defensive hedge condition confirmed. Size protection before adding any new directional risk.":"Capital-preservation reduction condition confirmed."
    },
    scenarios,evidence,unavailable,disclaimer:DISCLAIMER
  };
}

async function serveStatic(pathname,res){
  const rel=pathname==="/"? "index.html":pathname.replace(/^\//,"");
  const safe=normalize(rel).replace(/^\.\.(?:[\\/]|$)/g,"");
  const file=join(PUBLIC_DIR,safe);
  try{
    const body=await readFile(file);
    const ext=extname(file);
    const types={".html":"text/html; charset=utf-8",".js":"application/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
    res.writeHead(200,{"content-type":types[ext]||"application/octet-stream","cache-control":"no-store","x-frame-options":"DENY","referrer-policy":"no-referrer"});
    res.end(body);
  }catch{json(res,404,{error:"not_found"});}
}

const server=http.createServer(async(req,res)=>{
  if(!authed(req)) return unauthorized(res);
  try{
    const url=new URL(req.url||"/","http://"+(req.headers.host||"localhost"));
    if(req.method==="GET"&&url.pathname==="/api/analyze") return json(res,200,await analyze(url.searchParams));
    if(req.method==="GET"&&url.pathname==="/api/health") return json(res,200,{ok:true,paperOnly:true,executionEnabled:false,binance:"public-futures",time:new Date().toISOString()});
    if(req.method==="GET") return serveStatic(url.pathname,res);
    return json(res,405,{error:"method_not_allowed"});
  }catch(e){return json(res,502,{error:String(e?.message||e),paperOnly:true});}
});
server.listen(PORT,HOST,()=>console.log(JSON.stringify({event:"rescue_dashboard_ready",host:HOST,port:PORT,paperOnly:true,executionEnabled:false})));
