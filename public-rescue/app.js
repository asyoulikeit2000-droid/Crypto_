const $=s=>document.querySelector(s);
const f=(x,d=5)=>Number.isFinite(Number(x))?Number(x).toLocaleString(undefined,{maximumFractionDigits:d}):"—";
const pc=x=>Number.isFinite(Number(x))?((Number(x)>=0?"+":"")+(Number(x)*100).toFixed(2)+"%"):"—";
const money=x=>Number.isFinite(Number(x))?new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(x)):"—";
function q(){return new URLSearchParams({symbol:$("#symbol").value.trim(),direction:$("#direction").value,entry:$("#entry").value,notional:$("#notional").value,margin:$("#margin").value});}
function row(k,v,cls=""){return '<div><span>'+k+'</span><strong class="'+cls+'">'+v+'</strong></div>';}
async function load(){
  $("#fresh").textContent="UPDATING";
  try{
    const r=await fetch("/api/analyze?"+q().toString(),{cache:"no-store"}); if(!r.ok) throw new Error("HTTP "+r.status);
    const d=await r.json(), m=d.market, p=d.position, dc=d.decision;
    $("#fresh").textContent="LIVE · "+new Date(d.generatedAt).toLocaleTimeString();
    $("#action").textContent=dc.action; $("#action").className=dc.action==="HOLD"?"hold":dc.action==="HEDGE"?"hedge":"reduce";
    $("#summary").textContent=dc.summary; $("#confidence").textContent=dc.confidence+"%";
    $("#price").textContent=f(m.price,6); $("#basis").textContent="mark "+f(m.mark,6)+" · index "+f(m.index,6);
    $("#pnl").textContent=money(p.pnlUsdt); $("#pnl").className=p.pnlUsdt>=0?"up":"down"; $("#pnlPct").textContent=pc(p.pnlPct);
    $("#roe").textContent=pc(p.roe); $("#roe").className=p.roe>=0?"up":"down"; $("#lev").textContent=f(d.leverage,2)+"× effective leverage";
    $("#profitability").textContent=dc.profitability; $("#need").textContent="Entry requires "+pc(p.recoveryNeededPct)+" from here";
    $("#levels").innerHTML=[
      row("H1 hedge trigger",f(dc.hedgeTrigger,6)),
      row("4H 50% hedge",f(dc.hard4h,6)),
      row("4H reduce zone",f(dc.reduceTrigger,6)),
      row("Recovery milestone 1",f(dc.resistance1,6)),
      row("Recovery milestone 2",f(dc.resistance2,6)),
      row("Bullish milestone",f(dc.resistance3,6))
    ].join("");
    $("#bearStatus").textContent=d.scenarios.bearish.status; $("#bearText").textContent=d.scenarios.bearish.next;
    $("#baseStatus").textContent=d.scenarios.base.status; $("#baseText").textContent=d.scenarios.base.next;
    $("#bullStatus").textContent=d.scenarios.bullish.status; $("#bullText").textContent=d.scenarios.bullish.next;
    $("#derivs").innerHTML=[
      row("Funding",m.funding==null?"Unavailable":pc(m.funding)),
      row("Open interest",f(m.openInterest,0)),
      row("OI 24h",m.oiChange24h==null?"Unavailable":pc(m.oiChange24h)),
      row("Global long",m.globalLong==null?"Unavailable":pc(m.globalLong)),
      row("Top trader long",m.topLong==null?"Unavailable":pc(m.topLong)),
      row("Taker buy/sell",f(m.takerRatio,2)),
      row("Book bid/ask",f(m.bookRatio,2))
    ].join("");
    const t=d.timeframes;
    $("#tf").innerHTML=[
      row("H1 RSI",f(t.h1?.rsi14,1)),row("H1 EMA20",f(t.h1?.ema20,6)),
      row("H4 RSI",f(t.h4?.rsi14,1)),row("H4 EMA20",f(t.h4?.ema20,6)),
      row("D1 RSI",f(t.d1?.rsi14,1)),row("D1 EMA20",f(t.d1?.ema20,6))
    ].join("");
    $("#score").textContent="Score "+dc.score;
    $("#evidence").innerHTML=d.evidence.map(e=>'<div class="ev"><div><b>'+e.label+'</b><span class="q '+e.quality+'">'+e.quality+'</span></div><p>'+e.detail+'</p><em>'+ (e.value>0?"supportive":e.value<0?"bearish":"neutral") +'</em></div>').join("");
    $("#unavailable").textContent=d.unavailable.length?"Unavailable this run: "+d.unavailable.join(", "):"All requested Binance components available.";
  }catch(e){$("#fresh").textContent="ERROR";$("#summary").textContent=String(e.message||e);}
}
$("#run").addEventListener("click",load);
["symbol","direction","entry","notional","margin"].forEach(id=>$("#"+id).addEventListener("change",load));
load(); setInterval(load,60000);