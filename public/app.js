let D={},marketQuery="",marketSort="rank",dashboardFetchedAt=null,dashboardError=null;
const $=s=>document.querySelector(s),$$=s=>Array.from(document.querySelectorAll(s));
const A=x=>String(x??"—"),num=(x,d=6)=>{const n=Number(x);return Number.isFinite(n)?n.toLocaleString(undefined,{maximumFractionDigits:d}):"—"};
const pct=x=>{const n=Number(x);return Number.isFinite(n)?`${n>=0?"+":""}${(n*100).toFixed(2)}%`:"—"};
const K=(o,...ks)=>{for(const k of ks)if(o?.[k]!=null)return o[k];return null};
const ageMs=x=>{const t=x?Date.parse(x):NaN;return Number.isFinite(t)&&t<=Date.now()?Date.now()-t:Infinity};
const ago=x=>{if(!Number.isFinite(ageMs(x)))return "—";const s=Math.round(ageMs(x)/1000);if(s<60)return `${s}s ago`;const m=Math.round(s/60);if(m<60)return `${m}m ago`;const h=Math.round(m/60);return `${h}h ago`};
const freshness=(x,freshMs=20000,warnMs=60000)=>{const ms=ageMs(x);if(!Number.isFinite(ms))return {label:"UNKNOWN",cls:"warn"};return ms<=freshMs?{label:"LIVE",cls:"fresh"}:ms<=warnMs?{label:"DELAYED",cls:"warn"}:{label:"STALE",cls:"stale"}};
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
  const h=D.health||{};
  const dashboardFresh=ageMs(dashboardFetchedAt)<20000&&!dashboardError;
  const feedsFresh=ageMs(h.lastTrade)<20000&&ageMs(h.lastBook)<20000;
  const live=dashboardFresh&&feedsFresh&&h.storageLive===true&&h.ready===true&&!h.killSwitch;
  const status=dashboardError?"ERROR":!dashboardFetchedAt?"UNKNOWN":!dashboardFresh||!feedsFresh?"STALE":live?"LIVE":"DEGRADED";
  const signalReady=!!h.safety?.signalReady,statReady=!!h.safety?.statisticalSignalReady,val=h.validation||{},cal=h.calibration||{},test=val.test||{},rob=val.robustness||{},hz=h.horizonResearch||{};
  $("#hero").textContent=status;
  $("#heroDot").style.background=live?"var(--green)":status==="ERROR"?"var(--red)":"var(--amber)";
  $("#dot").style.background=live?"var(--green)":status==="ERROR"?"var(--red)":"var(--amber)";
  $("#status").textContent=status+" TELEMETRY";
  $("#topStatus").textContent=status;
  const storageLabel=String(h.storageBackend||"unknown").replaceAll("_"," ").toUpperCase();
  $("#copy").textContent=dashboardError?`Dashboard unavailable: ${dashboardError}. Showing previously fetched data.`:!dashboardFresh?"Dashboard data is not current.":!feedsFresh?"Trade or order-book observations are stale or unknown.":live?`Market observations and ${storageLabel} database checks are current · paper-only research.`:"Engine readiness is degraded; check database health and kill switch.";
  $("#updated").textContent=dashboardFetchedAt?`${new Date(dashboardFetchedAt).toLocaleTimeString()} · ${ago(dashboardFetchedAt)}`:"No successful fetch";
  $("#assets").textContent=h.assets??0;
  $("#trades").textContent=(h.counts?.trades||0).toLocaleString();
  $("#books").textContent=(h.counts?.books||0).toLocaleString();
  $("#outcomesMetric").textContent=(cal.sampleCount||0).toLocaleString();
  $("#errors").textContent=(h.errors||[]).join("\n")||"None";
  const h1=hz.H1||{},h4=hz.H4||{},d1=hz.D1||{},mtf=hz.MTF||{};
  $("#h1State").textContent=A(h1.state||"VALIDATING");
  $("#h1Copy").textContent=`H1 evidence outcomes: ${A(h1.outcomes)} · actionable only after all model gates pass.`;
  $("#h4State").textContent=A(h4.state||"DATA_WARMING").replaceAll("_"," ");
  const h4t=h4.validation?.test||{}; $("#h4Copy").textContent=`${A(h4.readyAssets)} assets ready · ${A(h4.candidates)} candidates · ${A(h4.outcomes)} outcomes · OOS n=${A(h4t.n)} · avg ${num(h4t.avgPnl,4)} · total ${num(h4t.totalPnl,4)}`;
  $("#d1State").textContent=A(d1.state||"DATA_WARMING").replaceAll("_"," ");
  const d1t=d1.validation?.test||{}; $("#d1Copy").textContent=`${A(d1.readyAssets)} assets ready · ${A(d1.candidates)} candidates · ${A(d1.outcomes)} outcomes · OOS n=${A(d1t.n)} · avg ${num(d1t.avgPnl,4)} · total ${num(d1t.totalPnl,4)}`;
  $("#mtfState").textContent=A(mtf.state||"DATA_WARMING").replaceAll("_"," ");
  const mtft=mtf.validation?.test||{}; $("#mtfCopy").textContent=`${A(mtf.readyAssets)} assets ready · ${A(mtf.candidates)} candidates · ${A(mtf.outcomes)} outcomes · OOS n=${A(mtft.n)} · avg ${num(mtft.avgPnl,4)}`;

  const checks=[
    [val.split?.method==="purged_expanding_window"&&val.folds?.length>=5,"Independent windows","5 purged forward windows required"],
    [val.costCoverageComplete===true,"Cost coverage","Verified funding coverage required"],
    [cal.status==="ACTIVE","Calibration","ACTIVE required"],
    [val.status==="COMPLETE","Walk-forward","COMPLETE required"],
    [Number(test.n||0)>=20,"Test sample",`${Number(test.n||0)} / 20 minimum`],
    [Number(test.avgPnl||0)>0,"Average PnL",`${num(test.avgPnl,4)} must be > 0`],
    [Number(test.totalPnl||0)>0,"Total PnL",`${num(test.totalPnl,4)} must be > 0`]
  ];
  const passed=checks.filter(x=>x[0]).length;
  $("#modelGate").textContent=signalReady?"PRODUCTION ACTIONABLE":(statReady?"STATISTICALLY READY · ROBUSTNESS LOCKED":"SHADOW / NOT VALIDATED");
  $("#modelGate").className=signalReady?"up":"down";
  $("#modelCopy").textContent=signalReady?"Statistical and robustness gates passed. Actionable publishing is enabled.":(statReady?"Base validation passed, but multi-period robustness is not yet sufficient. Entries remain research-only.":"Actionable entries remain blocked until all evidence gates pass.");
  $("#gateGrid").innerHTML=checks.map(x=>gate(...x)).join("");
  $("#gateScore").textContent=`${passed} / ${checks.length} gates`;
  $("#gateBar").style.width=`${Math.round(passed/checks.length*100)}%`;
  $("#validationStats").textContent=`Current cohort from ${h.validationCohortStart?new Date(h.validationCohortStart).toLocaleString():"—"} · Test n=${A(test.n)} · win rate ${test.winRate!=null?num(Number(test.winRate)*100,1)+"%":"—"} · avg PnL ${num(test.avgPnl,4)} · total PnL ${num(test.totalPnl,4)} · calibration ${A(cal.status)}`;

  const market=filteredMarket();
  $("#liveMarket").innerHTML=market.length?market.slice(0,30).map(a=>{const f=freshness(a.updatedAt);return `<article class="market-card">
    <div class="market-top"><b>${A(a.symbol)}</b><span>#${A(a.rank)} · <i class="fresh-chip ${f.cls}">${f.label}</i> ${ago(a.updatedAt)}</span></div>
    <strong>$${num(a.price)}</strong>
    <div class="market-line"><span class="${Number(a.change24h)>=0?"up":"down"}">${pct(a.change24h)}</span><span class="muted">Vol ${num(a.volume24h,0)}</span></div>
    <div class="mini"><span>H $${num(a.high24h)}</span><span>L $${num(a.low24h)}</span><span>Spr ${num(a.spreadBps,2)} bps</span></div>
  </article>`}).join(""):"<div class=\"empty\">No assets match this filter.</div>";

  $("#universe").innerHTML=market.slice(0,10).map((a,i)=>`<div class="row"><span class="rank">${String(i+1).padStart(2,"0")}</span><b>${A(a.symbol)}</b><span>$${num(a.price)}</span><span class="${Number(a.change24h)>=0?"up":"down"}">${pct(a.change24h)}</span></div>`).join("")||"<div class=\"empty\">Universe unavailable.</div>";
  $("#providers").innerHTML=(D.providers||[]).slice(0,8).map(p=>`<div class="provider-row"><div><b>${A(p.provider)}</b><small>${A(p.dataset)}</small></div><span class="provider-status ${String(p.status).toLowerCase()}">${A(p.status)}</span><span class="muted">${ago(p.checked_at)}</span></div>`).join("")||"<div class=\"empty\">No provider status.</div>";

  const sig=D.signals||[];
  const activeModelId=h.model?.id||"rules_v3_selective";
  const actionable=sig.filter(s=>s.model_id===activeModelId&&String(s.risk_state||"").toUpperCase()!=="SHADOW");
  $("#cards").innerHTML=signalReady&&actionable.length?actionable.slice(0,6).map(s=>`<div class="card signal-card"><div class="card-top"><b>${A(K(s,"symbol","asset_id"))}</b>${badge(K(s,"action","signal","side"))}</div><div class="price">${K(s,"entry_price","entry")!=null?"$"+num(K(s,"entry_price","entry")):"—"}</div><div class="muted">${K(s,"probability","p_t1")!=null?num(Number(K(s,"probability","p_t1"))*100,2)+"% probability":"Probability pending"}</div><div class="muted">Created ${ago(s.created_at)}</div><hr><div class="muted">${A(K(s,"reasons","reason")||"Validated evidence set.")}</div></div>`).join(""):`<div class="locked-state"><div class="lock-icon">◈</div><div><b>No actionable signal yet</b><p>${signalReady?"Waiting for the next qualified setup.":"Historical candidates are retained for shadow validation, but entries are blocked until all model gates pass."}</p></div></div>`;

  $("#signalNotice").innerHTML=signalReady?`<b class="up">H1 production-actionable.</b> ${actionable.length} qualified H1 record(s) shown; H4/D1 remain shadow-only.`:(statReady?'<b class="down">H1 robustness locked.</b> Base validation passed, but time-slice robustness is insufficient; records remain research-only.':'<b class="down">Shadow mode.</b> These are research records, not approved entries.');
  $("#signalTable").innerHTML=tableSignals(sig);
  $("#marketTable").innerHTML=market.length?`<table><thead><tr><th>#</th><th>ASSET</th><th>PRICE</th><th>24H</th><th>VOLUME</th><th>SPREAD</th><th>FRESH</th></tr></thead><tbody>${market.map((a,i)=>`<tr><td>${i+1}</td><td><b>${A(a.symbol)}</b></td><td>$${num(a.price)}</td><td class="${Number(a.change24h)>=0?"up":"down"}">${pct(a.change24h)}</td><td>${num(a.volume24h,0)}</td><td>${num(a.spreadBps,2)} bps</td><td><span class="fresh-chip ${freshness(a.updatedAt).cls}">${freshness(a.updatedAt).label}</span> ${ago(a.updatedAt)}</td></tr>`).join("")}</tbody></table>`:"<div class=\"empty\">Universe unavailable.</div>";

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
  const qualityItems=[
    ["Trade feed",h.lastTrade,20000,60000,"Last trade observation processed (not exchange-event age)"],
    ["Order book",h.lastBook,20000,60000,"Last book observation processed (not exchange-event age)"],
    ["Derivatives receive",h.lastDerivReceivedAt,60000,180000,`Funding/OI received now · source event ${ago(h.lastDeriv)}`],
    [`${String(h.storageBackend||"storage").replaceAll("_"," ").toUpperCase()} persistence`,h.lastStorageWriteSuccessAt,60000,180000,h.storageLive===false?"Storage readiness is not currently passing.":"Last successful database write"]
  ];
  $("#quality").innerHTML=qualityItems.map(x=>{const f=!dashboardFresh?{label:"UNKNOWN",cls:"warn"}:x[0].endsWith("persistence")&&h.storageLive===false?{label:"DEGRADED",cls:"stale"}:freshness(x[1],x[2],x[3]);return `<div class="card quality-card"><span class="eyebrow">${x[0]}</span><div class="quality-title"><h2>${ago(x[1])}</h2><span class="fresh-chip ${f.cls}">${f.label}</span></div><p class="muted">${x[4]}</p><p class="muted mono">${A(x[1]||"No observation")}</p></div>`}).join("");
  renderScanner();
}

function tableSignals(rows){
  if(!rows.length)return '<div class="empty">No signal history yet.</div>';
  return `<table><thead><tr><th>ASSET</th><th>ACTION</th><th>HORIZON</th><th>PROB.</th><th>ENTRY</th><th>SL</th><th>T1</th><th>STATE</th><th>CREATED</th></tr></thead><tbody>${rows.map(r=>{const p=K(r,"probability","p_t1","confidence");return `<tr><td>${A(K(r,"symbol","asset_id"))}</td><td>${badge(K(r,"action","signal","side"))}</td><td>${A(r.horizon)}</td><td>${p!=null?num(Number(p)*100,2)+"%":"—"}</td><td>${K(r,"entry_price","entry")!=null?"$"+num(K(r,"entry_price","entry")):"—"}</td><td>${r.stop_loss!=null?"$"+num(r.stop_loss):"—"}</td><td>${r.target_1!=null?"$"+num(r.target_1):"—"}</td><td>${String(r.risk_state||"SHADOW").toUpperCase()}</td><td>${ago(r.created_at)}<br><small>${Number.isFinite(ageMs(r.created_at))?new Date(r.created_at).toLocaleString():"Unknown"}</small></td></tr>`}).join("")}</tbody></table>`;
}

async function loadDashboard(){
  try{const r=await fetch("/api/dashboard",{cache:"no-store"});if(!r.ok)throw Error("Dashboard API "+r.status);const payload=await r.json();D=payload;dashboardFetchedAt=new Date().toISOString();dashboardError=null;render()}
  catch(e){dashboardError=e.message;render()}
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
setInterval(()=>{if(!document.hidden)render()},1000);

function classLabel(v){return String(v||"neutral").replaceAll("_"," ").toUpperCase()}
function renderScanner(){
  const root=$("#scannerTable"); if(!root)return;
  const s=D.preRally||{},rows=Array.isArray(s.tokens)?s.tokens:[];
  $("#scannerStatus").innerHTML=s.enabled
    ? `<b class="${s.lastError?"down":"up"}">${s.lastError?"DEGRADED":"ACTIVE"}</b> · provider ${A(s.provider)} · last success ${ago(s.lastSuccessAt)}${s.lastError?" · "+A(s.lastError):""}`
    : '<b class="down">DISABLED</b> · scanner is administratively disabled.';
  const research=rows.filter(x=>x.classification==="research_candidate"||x.classification==="high_priority_watch").length;
  const risky=rows.filter(x=>(x.criticalFlags||[]).length).length;
  $("#scannerMetrics").innerHTML=[
    ["Monitored",rows.length],["Research candidates",research],["Critical-risk",risky],["Last scan",ago(s.lastSuccessAt)]
  ].map(([k,v])=>`<div class="summary-card"><small>${k}</small><strong>${v}</strong></div>`).join("");
  root.innerHTML=rows.length?`<table><thead><tr><th>TOKEN</th><th>CHAIN</th><th>PRICE</th><th>LIQUIDITY</th><th>24H VOL</th><th>PRE-RALLY</th><th>CONF.</th><th>COVERAGE</th><th>CLASS</th><th>RISKS</th></tr></thead><tbody>${rows.map((r,i)=>`<tr class="scanner-row" data-scanner-index="${i}"><td><b>${A(r.tokenSymbol)}</b><br><small>${A(r.tokenName)}</small></td><td>${A(r.chainId)}</td><td>${r.priceUsd!=null?"$"+num(r.priceUsd):"—"}</td><td>${r.liquidityUsd!=null?"$"+num(r.liquidityUsd,0):"—"}</td><td>${r.volume24h!=null?"$"+num(r.volume24h,0):"—"}</td><td><b>${A(r.preRallyScore)}</b></td><td>${A(r.confidenceScore)}</td><td>${A(r.dataCoverageScore)}</td><td><span class="scanner-class ${r.classification}">${classLabel(r.classification)}</span></td><td>${(r.criticalFlags||[]).length+(r.warningFlags||[]).length}</td></tr>`).join("")}</tbody></table>`:'<div class="empty">No scanner candidates yet. This is expected until the worker completes its first discovery cycle.</div>';
  $$(".scanner-row").forEach(x=>x.onclick=()=>showScannerDetail(rows[Number(x.dataset.scannerIndex)]));
}
function showScannerDetail(r){
  if(!r)return;
  $("#scannerDetail").innerHTML=`<article class="panel scanner-token-panel">
    <div class="scanner-token-head"><div><span class="eyebrow">TOKEN RESEARCH</span><h3>${A(r.tokenName)} · ${A(r.tokenSymbol)}</h3><p class="muted">${A(r.chainId)} · ${A(r.tokenAddress)}</p></div><span class="scanner-class ${r.classification}">${classLabel(r.classification)}</span></div>
    <div class="scanner-score-grid">
      <div><small>Pre-Rally Score</small><strong>${A(r.preRallyScore)}/100</strong></div>
      <div><small>Confidence</small><strong>${A(r.confidenceScore)}/100</strong></div>
      <div><small>Data Coverage</small><strong>${A(r.dataCoverageScore)}/100</strong></div>
    </div>
    <p>${A(r.explanation)}</p>
    <div class="scanner-breakdown"><div><b>Positive signals</b><p>${(r.positiveSignals||[]).map(A).join(" · ")||"Limited evidence"}</p></div><div><b>Warnings</b><p>${(r.warningFlags||[]).map(A).join(" · ")||"None detected from available data"}</p></div><div><b>Critical flags</b><p>${(r.criticalFlags||[]).map(A).join(" · ")||"None detected from available data"}</p></div><div><b>Missing data</b><p>${(r.missingData||[]).map(A).join(" · ")||"None"}</p></div></div>
    <div class="scanner-disclaimer">This is an automated research signal based on market and blockchain data. It is not financial advice, does not guarantee future price movement, and may produce false positives.</div>
  </article>`;
  $("#scannerDetail").scrollIntoView({behavior:"smooth",block:"nearest"});
}
async function loadScanner(){
  try{const r=await fetch("/api/pre-rally",{cache:"no-store"});if(r.ok){D.preRally=await r.json();renderScanner()}}catch{}
}
loadScanner();
setInterval(()=>{if(!document.hidden)loadScanner()},30000);
