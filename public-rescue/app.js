const $=s=>document.querySelector(s);
const f=(x,d=5)=>Number.isFinite(Number(x))?Number(x).toLocaleString(undefined,{maximumFractionDigits:d}):"—";
const pc=x=>Number.isFinite(Number(x))?((Number(x)>=0?"+":"")+(Number(x)*100).toFixed(2)+"%"):"—";
const pp=x=>Number.isFinite(Number(x))?((Number(x)>=0?"+":"")+Number(x).toFixed(2)+" pts"):"—";
const money=x=>Number.isFinite(Number(x))?new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(x)):"—";
function q(){return new URLSearchParams({symbol:$("#symbol").value.trim(),direction:$("#direction").value,entry:$("#entry").value,notional:$("#notional").value,margin:$("#margin").value,hedgeNotional:$("#hedgeNotional").value});}
function row(k,v,cls=""){return '<div><span>'+k+'</span><strong class="'+cls+'">'+v+'</strong></div>';}
async function load(){
 $("#fresh").textContent="UPDATING";
 try{
  const r=await fetch("/api/analyze?"+q().toString(),{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);
  const d=await r.json(),m=d.market,p=d.position,dc=d.decision,b=d.broader||{};
  $("#fresh").textContent="LIVE · "+new Date(d.generatedAt).toLocaleTimeString();
  $("#action").textContent=dc.action;$("#action").className=dc.action==="HOLD"||dc.action==="EXIT-HEDGE"?"hold":dc.action==="HEDGE"?"hedge":"reduce";
  $("#secondary").textContent=dc.secondaryAction||"";$("#summary").textContent=dc.summary;$("#confidence").textContent=dc.confidence+"%";
  $("#price").textContent=f(m.price,6);$("#basis").textContent="spot "+f(m.spotPrice,6)+" · basis "+f(m.spotBasisBps,1)+" bps";
  $("#pnl").textContent=money(p.pnlUsdt);$("#pnl").className=p.pnlUsdt>=0?"up":"down";$("#pnlPct").textContent=pc(p.pnlPct);
  $("#roe").textContent=pc(p.roe);$("#roe").className=p.roe>=0?"up":"down";$("#lev").textContent=f(d.leverage,2)+"× effective leverage";
  $("#profitability").textContent=dc.profitability;$("#need").textContent="Entry requires "+pc(p.recoveryNeededPct)+" from here";
  $("#framework").textContent=dc.source==="agreed_grt_rescue_framework"?"AGREED GRT FRAMEWORK":"DYNAMIC";
  $("#levels").innerHTML=[row("H1 hedge ~25%",f(dc.hedgeTrigger,6)),row("4H hedge ~50%",f(dc.hard4h,6)),row("4H reduce 20–25%",f(dc.reduceTrigger,6)),row("Recovery milestone",f(dc.resistance1,6)),row("Recovery confirmation",f(dc.resistance2,6)),row("Stronger hold milestone",f(dc.resistance3,6))].join("");
  $("#bearStatus").textContent=d.scenarios.bearish.status;$("#bearText").textContent=d.scenarios.bearish.next;$("#baseStatus").textContent=d.scenarios.base.status;$("#baseText").textContent=d.scenarios.base.next;$("#bullStatus").textContent=d.scenarios.bullish.status;$("#bullText").textContent=d.scenarios.bullish.next;
  $("#derivs").innerHTML=[row("Funding",m.funding==null?"Unavailable":pc(m.funding)),row("Open interest",f(m.openInterest,0)),row("OI 24h",m.oiChange24h==null?"Unavailable":pc(m.oiChange24h)),row("Global long",m.globalLong==null?"Unavailable":pc(m.globalLong)),row("Top position long",m.topLong==null?"Unavailable":pc(m.topLong)),row("Top account long",m.topAccountLong==null?"Unavailable":pc(m.topAccountLong)),row("Taker buy/sell",f(m.takerRatio,2)),row("Book bid/ask",f(m.bookRatio,2)),row("Spot/perp basis",m.spotBasisBps==null?"Unavailable":f(m.spotBasisBps,1)+" bps")].join("");
  $("#macro").innerHTML=[row("BTC",f(b.btc?.price,0)+" · "+(b.btc?.change24==null?"—":f(b.btc.change24,2)+"%")),row("ETH",f(b.eth?.price,0)+" · "+(b.eth?.change24==null?"—":f(b.eth.change24,2)+"%")),row("Macro score",f(b.macroScore,2)),row("GRT rel. strength 24h",b.relative24==null?"Unavailable":pp(b.relative24)),row("GRT rel. strength 4H",b.relative4h==null?"Unavailable":pc(b.relative4h))].join("");
  const t=d.timeframes;$("#tf").innerHTML=[row("H1 RSI",f(t.h1?.rsi14,1)),row("H1 EMA20",f(t.h1?.ema20,6)),row("H4 RSI",f(t.h4?.rsi14,1)),row("H4 EMA20",f(t.h4?.ema20,6)),row("H4 volume",t.h4?.volumeRatio==null?"Unavailable":f(t.h4.volumeRatio,2)+"× avg"),row("D1 RSI",f(t.d1?.rsi14,1)),row("D1 EMA20",f(t.d1?.ema20,6))].join("");
  $("#risk").innerHTML=[row("Liquidation tape",d.liquidations?.available?"Available":"Unavailable"),row("Long liquidations",d.liquidations?.available?money(d.liquidations.longUsd):"Unavailable"),row("Short liquidations",d.liquidations?.available?money(d.liquidations.shortUsd):"Unavailable"),row("ADL",d.adl?.available?"Available":"Unavailable"),row("On-chain / exchange flow",d.onchain?.available?"Available":"Unavailable")].join("");
  $("#profitPlan").textContent="At "+f(d.profitPlan.entryZone,6)+" entry recovery, de-risk part of the position. Partial-profit / capital-protection zone: "+f(d.profitPlan.partialProfitZone[0],6)+"–"+f(d.profitPlan.partialProfitZone[1],6)+". Hold only a runner above "+f(d.profitPlan.extensionTrigger,6)+" when spot participation, taker flow, OI quality and BTC/ETH regime remain supportive.";
  $("#newsQuality").textContent=d.news?.available?(d.news.quality+" · "+d.news.provider):"UNAVAILABLE";
  $("#news").innerHTML=d.news?.items?.length?d.news.items.map(x=>'<div class="news-item"><b>'+x.title+'</b><small>'+[x.source,x.pubDate].filter(Boolean).join(" · ")+'</small></div>').join(""):'<div class="empty">No current catalyst feed available.</div>';
  $("#score").textContent="Score "+dc.score;$("#evidence").innerHTML=d.evidence.map(e=>'<div class="ev"><div><b>'+e.label+'</b><span class="q '+e.quality+'">'+e.quality+'</span></div><p>'+e.detail+'</p><em>'+e.source+' · '+(e.value>0?"supportive":e.value<0?"bearish":"neutral")+'</em></div>').join("");
  const miss=[...(d.unavailable||[])];if(!d.adl?.available)miss.push("ADL: "+d.adl.reason);if(!d.onchain?.available)miss.push("On-chain/exchange flow: "+d.onchain.reason);$("#unavailable").textContent=miss.length?"Unavailable / omitted this run: "+miss.join(" | "):"All configured components available.";
 }catch(e){$("#fresh").textContent="ERROR";$("#summary").textContent=String(e.message||e);}
}
$("#run").addEventListener("click",load);["symbol","direction","entry","notional","margin","hedgeNotional"].forEach(id=>$("#"+id).addEventListener("change",load));load();setInterval(load,60000);