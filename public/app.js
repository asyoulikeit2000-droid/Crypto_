let D={},marketQuery="",marketSort="rank";
const $=s=>document.querySelector(s),$$=s=>Array.from(document.querySelectorAll(s));
const A=x=>String(x??"—"),num=(x,d=6)=>{const n=Number(x);return Number.isFinite(n)?n.toLocaleString(undefined,{maximumFractionDigits:d}):"—"};
const pct=x=>{const n=Number(x);return Number.isFinite(n)?`${n>=0?"+":""}${(n*100).toFixed(2)}%`:"—"};
const K=(o,...ks)=>{for(const k of ks)if(o?.[k]!=null)return o[k];return null};
const ago=x=>x?`${Math.max(0,Math.round((Date.now()-Date.parse(x))/1000))}s ago`:"—";
const badge=x=>{const v=String(x||"NO TRADE").toUpperCase(),c=v==="LONG"?"long":v==="SHORT"?"short":"none";return `<span class="badge ${c}">${A(v)}</span>`};
const gate=(ok,label,detail)=>`<div class="gate ${ok?"pass":"wait"}"><i>${ok?"✓":"•"}</i><div><b>${label}</b><small>${detail}</small></div></div>`;

function navigate(id){
  $$("[data-s]").forEach(x=>x.classList.toggle("on",x.dataset.s===id));
  $$("main section").forEach(x=>x.classList.toggle("active",x.id===id));
  const b=$(`.side-nav button[data-s="${id}"]`);
  if(b)$("#title").textContent=b.textContent.trim();
  window.scrollTo({top:0,behavior:"smooth"});
}

function filteredMarket(){
  let rows=[...(D.market||[])];
  const q=marketQuery.trim().toUpperCase();
  if(q)rows=rows.filter(x=>String(x.symbol||"").toUpperCase().includes(q));
  if(marketSort==="change")rows.sort((a,b)=>Number(b.change24h||0)-Number(a.change24h||0));
  else if(marketSort==="volume")rows.sort((a,b)=>Number(b.volume24h||0)-Number(a.volume24h||0));
  else rows.sort((a,b)=>Number(a.rank||999)-Number(b.rank||999));
  return rows;
}

function render(){
  const h=D.health||{},live=!!h.lastTrade&&Date.now()-Date.parse(h.lastTrade)<2e4;
  const signalReady=!!h.safety?.signalReady,val=h.validation||{},cal=h.calibration||{},test=val.test||{};
  $("#hero").textContent=live?"LIVE":"STALE";
  $("#heroDot").style.background=live?"var(--green)":"var(--amber)";
  $("#dot").style.background=live?"var(--green)":"var(--amber)";
  $("#status").textContent=live?"LIVE TELEMETRY":"STALE TELEMETRY";
  $("#topStatus").textContent=live?"LIVE":"STALE";
  $("#copy").textContent=live?"Live market telemetry is being received.":"No recent trade event passed the freshness gate.";
  $("#updated").textContent=new Date().toLocaleTimeString();
  $("#assets").textContent=h.assets??0;
  $("#trades").textContent=(h.counts?.trades||0).toLocaleString();
  $("#books").textContent=(h.counts?.books||0).toLocaleString();
  $("#outcomesMetric").textContent=(cal.sampleCount||0).toLocaleString();
  $("#errors").textContent=(h.errors||[]).join("\n")||"None";

  const checks=[
    [cal.status==="ACTIVE","Calibration","ACTIVE required"],
    [val.status==="COMPLETE","Walk-forward","COMPLETE required"],
    [Number(test.n||0)>=20,"Test sample",`${Number(test.n||0)} / 20 minimum`],
    [Number(test.avgPnl||0)>0,"Average PnL",`${num(test.avgPnl,4)} must be > 0`],
    [Number(test.totalPnl||0)>0,"Total PnL",`${num(test.totalPnl,4)} must be > 0`]
  ];
  const passed=checks.filter(x=>x[0]).length;
  $("#modelGate").textContent=signalReady?"VALIDATED":"SHADOW / NOT VALIDATED";
  $("#modelGate").className=signalReady?"up":"down";
  $("#modelCopy").textContent=signalReady?"All gates passed. Actionable signal publishing is enabled.":"Engine is live; actionable entries remain blocked until all evidence gates pass.";
  $("#gateGrid").innerHTML=checks.map(x=>gate(...x)).join("");
  $("#gateScore").textContent=`${passed} / ${checks.length} gates`;
  $("#gateBar").style.width=`${Math.round(passed/checks.length*100)}%`;
  $("#validationStats").textContent=`Test n=${A(test.n)} · win rate ${test.winRate!=null?num(Number(test.winRate)*100,1)+"%":"—"} · avg PnL ${num(test.avgPnl,4)} · total PnL ${num(test.totalPnl,4)} · calibration ${A(cal.status)}`;

  const market=filteredMarket();
  $("#liveMarket").innerHTML=market.length?market.slice(0,30).map(a=>`<article class="market-card">
    <div class="market-top"><b>${A(a.symbol)}</b><span>#${A(a.rank)} · ${ago(a.updatedAt)}</span></div>
    <strong>$${num(a.price)}</strong>
    <div class="market-line"><span class="${Number(a.change24h)>=0?"up":"down"}">${pct(a.change24h)}</span><span class="muted">Vol ${num(a.volume24h,0)}</span></div>
    <div class="mini"><span>H $${num(a.high24h)}</span><span>L $${num(a.low24h)}</span><span>Spr ${num(a.spreadBps,2)} bps</span></div>
  </article>`).join(""):"<div class=\"empty\">No assets match this filter.</div>";

  $("#universe").innerHTML=market.slice(0,10).map((a,i)=>`<div class="row"><span class="rank">${String(i+1).padStart(2,"0")}</span><b>${A(a.symbol)}</b><span>$${num(a.price)}</span><span class="${Number(a.change24h)>=0?"up":"down"}">${pct(a.change24h)}</span></div>`).join("")||"<div class=\"empty\">Universe unavailable.</div>";
  $("#providers").innerHTML=(D.providers||[]).slice(0,8).map(p=>`<div class="provider-row"><div><b>${A(p.provider)}</b><small>${A(p.dataset)}</small></div><span class="provider-status ${String(p.status).toLowerCase()}">${A(p.status)}</span><span class="muted">${ago(p.checked_at)}</span></div>`).join("")||"<div class=\"empty\">No provider status.</div>";

  const sig=D.signals||[];
  $("#cards").innerHTML=signalReady&&sig.length?sig.slice(0,6).map(s=>`<div class="card signal-card"><div class="card-top"><b>${A(K(s,"symbol","asset_id"))}</b>${badge(K(s,"action","signal","side"))}</div><div class="price">${K(s,"entry_price","entry")!=null?"$"+num(K(s,"entry_price","entry")):"—"}</div><div class="muted">${K(s,"probability","p_t1")!=null?num(Number(K(s,"probability","p_t1"))*100,2)+"% probability":"Probability pending"}</div><hr><div class="muted">${A(K(s,"reasons","reason")||"Validated evidence set.")}</div></div>`).join(""):`<div class="locked-state"><div class="lock-icon">◈</div><div><b>No actionable signal yet</b><p>${signalReady?"Waiting for the next qualified setup.":"Historical candidates are retained for shadow validation, but entries are blocked until all model gates pass."}</p></div></div>`;

  $("#signalNotice").innerHTML=signalReady?'<b class="up">Model validated.</b> Historical and current qualified signals may be actionable under the paper-only policy.':'<b class="down">Shadow mode.</b> These are research records, not approved entries.';
  $("#signalTable").innerHTML=tableSignals(sig);
  $("#marketTable").innerHTML=market.length?`<table><thead><tr><th>#</th><th>ASSET</th><th>PRICE</th><th>24H</th><th>VOLUME</th><th>SPREAD</th><th>FRESH</th></tr></thead><tbody>${market.map((a,i)=>`<tr><td>${i+1}</td><td><b>${A(a.symbol)}</b></td><td>$${num(a.price)}</td><td class="${Number(a.change24h)>=0?"up":"down"}">${pct(a.change24h)}</td><td>${num(a.volume24h,0)}</td><td>${num(a.spreadBps,2)} bps</td><td>${ago(a.updatedAt)}</td></tr>`).join("")}</tbody></table>`:"<div class=\"empty\">Universe unavailable.</div>";

  const paper=D.paperTrades||[];
  const closed=paper.filter(x=>x.status&&String(x.status).toUpperCase()!=="OPEN");
  const pnls=closed.map(x=>Number(x.realized_pnl)).filter(Number.isFinite),total=pnls.reduce((a,b)=>a+b,0),wins=pnls.filter(x=>x>0).length;
  $("#paperSummary").innerHTML=[
    ["Records",paper.length],
    ["Closed",closed.length],
    ["Win rate",closed.length?`${(wins/closed.length*100).toFixed(1)}%`:"—"],
    ["Total PnL",num(total,4)]
  ].map(([k,v])=>`<div class="summary-card"><small>${k}</small><strong>${v}</strong></div>`).join("");
  $("#paperTable").innerHTML=paper.length?`<table><thead><tr><th>ASSET</th><th>SIDE</th><th>ENTRY</th><th>EXIT</th><th>PNL</th><th>OPENED</th><th>STATUS</th></tr></thead><tbody>${paper.map(r=>`<tr><td>${A(K(r,"symbol","asset_id"))}</td><td>${badge(K(r,"side","action"))}</td><td>${r.entry_price!=null?"$"+num(r.entry_price):"—"}</td><td>${r.exit_price!=null?"$"+num(r.exit_price):"—"}</td><td class="${Number(r.realized_pnl)>=0?"up":"down"}">${r.realized_pnl!=null?num(r.realized_pnl,4):"—"}</td><td>${r.opened_at?ago(r.opened_at):"—"}</td><td>${A(r.status)}</td></tr>`).join("")}</tbody></table>`:"<div class=\"empty\">No paper trade records yet.</div>";
  $("#quality").innerHTML=[["Trade stream",h.lastTrade],["Order book",h.lastBook],["Derivatives",h.lastDeriv]].map(x=>`<div class="card quality-card"><span class="eyebrow">${x[0]}</span><h2>${ago(x[1])}</h2><p class="muted">${A(x[1]||"No observation")}</p></div>`).join("");
}

function tableSignals(rows){
  if(!rows.length)return '<div class="empty">No signal history yet.</div>';
  return `<table><thead><tr><th>ASSET</th><th>ACTION</th><th>HORIZON</th><th>PROB.</th><th>ENTRY</th><th>SL</th><th>T1</th><th>STATE</th></tr></thead><tbody>${rows.map(r=>{const p=K(r,"probability","p_t1","confidence");return `<tr><td>${A(K(r,"symbol","asset_id"))}</td><td>${badge(K(r,"action","signal","side"))}</td><td>${A(r.horizon)}</td><td>${p!=null?num(Number(p)*100,2)+"%":"—"}</td><td>${K(r,"entry_price","entry")!=null?"$"+num(K(r,"entry_price","entry")):"—"}</td><td>${r.stop_loss!=null?"$"+num(r.stop_loss):"—"}</td><td>${r.target_1!=null?"$"+num(r.target_1):"—"}</td><td>SHADOW</td></tr>`}).join("")}</tbody></table>`;
}

async function loadDashboard(){
  try{const r=await fetch("/api/dashboard",{cache:"no-store"});if(!r.ok)throw Error("Dashboard API "+r.status);D=await r.json();render()}
  catch(e){$("#hero").textContent="ERROR";$("#copy").textContent=e.message;$("#topStatus").textContent="ERROR";$("#dot").style.background="var(--red)"}
}
async function loadMarket(){
  try{const r=await fetch("/api/market",{cache:"no-store"});if(r.ok){const m=await r.json();D.market=m.assets||[];render()}}catch{}
}

$$("[data-s]").forEach(b=>b.onclick=()=>navigate(b.dataset.s));
$$("[data-jump]").forEach(b=>b.onclick=()=>navigate(b.dataset.jump));
$("#refresh").onclick=()=>{loadDashboard();loadMarket()};
$("#marketSearch").oninput=e=>{marketQuery=e.target.value;render()};
$("#marketSort").onchange=e=>{marketSort=e.target.value;render()};
loadDashboard();
setInterval(()=>{if(!document.hidden)loadMarket()},2000);
setInterval(()=>{if(!document.hidden)loadDashboard()},10000);