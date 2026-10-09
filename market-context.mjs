// Public bounded context; thresholds are unvalidated research rules.
const DAY=86400000,HOUR=3600000,CM='https://community-api.coinmetrics.io/v4';
export const ASSETS={BTCUSDT:'btc',ETHUSDT:'eth',XRPUSDT:'xrp',ZECUSDT:'zec',DOGEUSDT:'doge',ADAUSDT:'ada',LINKUSDT:'link',QNTUSDT:'qnt',BNBUSDT:'bnb',AAVEUSDT:'aave',UNIUSDT:'uni',AVAXUSDT:'avaxc'};
const NAMES={BTCUSDT:'bitcoin|btc',ETHUSDT:'ethereum|ether|eth',SOLUSDT:'solana',XRPUSDT:'xrp|ripple',ZECUSDT:'zcash',NEARUSDT:'near protocol',HYPEUSDT:'hyperliquid',OGNUSDT:'origin protocol',ONDOUSDT:'ondo',STRKUSDT:'starknet',ENAUSDT:'ethena',DOGEUSDT:'dogecoin',PUMPFUNUSDT:'pump.fun',SUIUSDT:'sui',ADAUSDT:'cardano',RLCUSDT:'iexec','1000PEPEUSDT':'pepe',AVAXUSDT:'avalanche',TIAUSDT:'celestia',TAOUSDT:'bittensor',LINKUSDT:'chainlink',SANDUSDT:'sandbox',QNTUSDT:'quant',KAIAUSDT:'kaia',BNBUSDT:'binance coin|bnb',METUSDT:'meteora',AAVEUSDT:'aave',UNIUSDT:'uniswap'};
const decode=s=>String(s||'').replace(/<!\[CDATA\[|\]\]>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#(?:39|x27);/gi,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
const safeUrl=s=>{try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
export function parseRss(xml,now=Date.now()) {
 const rows=[...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(([_,body])=>{
  const pick=tag=>decode(body.match(new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)<\\/'+tag+'>','i'))?.[1]).trim();
  return {title:pick('title').slice(0,250),url:pick('link'),publishedAt:Date.parse(pick('pubDate'))};
 }).filter(x=>x.title&&safeUrl(x.url)&&Number.isFinite(x.publishedAt)&&x.publishedAt<=now+60000).sort((a,b)=>b.publishedAt-a.publishedAt);
 return [...new Map(rows.map(x=>[x.url,x])).values()].slice(0,40);
}
export function stablecoinContext(rows,now=Date.now()) {
 const data=(Array.isArray(rows)?rows:[]).map(x=>({at:Number(x.date)*1000,usd:Number(x.totalCirculatingUSD?.peggedUSD)})).filter(x=>Number.isFinite(x.at)&&x.at<=now+60000&&x.usd>0).sort((a,b)=>a.at-b.at);
 const last=data.at(-1),prior=data.filter(x=>last&&x.at<=last.at-7*DAY).at(-1);
 if(!last||now-last.at>2*DAY||!prior)throw Error('Stablecoin supply evidence stale or incomplete');
 return {available:true,source:'DefiLlama',url:'https://stablecoins.llama.fi/stablecoincharts/all',observedAt:last.at,usdSupply:last.usd,change7dPct:(last.usd/prior.usd-1)*100,scope:'Global USD-pegged stablecoin supply; not asset-specific exchange inflows or whale activity'};
}
export function easternTime(year,month,day,hour=0,minute=0) {
 const naive=Date.UTC(year,month-1,day,hour,minute);let at=naive;
 const f=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 for(let i=0;i<3;i++){const p=Object.fromEntries(f.formatToParts(at).map(x=>[x.type,x.value]));at+=naive-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);}
 return at;
}
export function parseCalendar(ics,source,url,now=Date.now()) {
 if(!String(ics).includes('BEGIN:VCALENDAR'))throw Error('Invalid calendar response');
 const unfolded=String(ics).replace(/\r?\n[ \t]/g,'');
 const events=[...unfolded.matchAll(/BEGIN:VEVENT\s*([\s\S]*?)END:VEVENT/g)].map(([_,body])=>{
  const title=body.match(/^SUMMARY:(.*)$/m)?.[1]?.trim().replace(/\\n/g,' ').replace(/\\([,;\\])/g,'$1');
  const d=body.match(/^DTSTART([^:]*):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)\s*$/m);
  if(!title)return null;
  const important=/Consumer Price Index|Producer Price Index|Employment Situation|Job Openings and Labor Turnover|Employment Cost Index|Gross Domestic Product|GDP|Personal Income and Outlays/i.test(title);
  if(!d){if(important)throw Error('Unrecognized important-event timestamp');return null;}
  const check=new Date(Date.UTC(+d[2],+d[3]-1,+d[4]));
  if(check.getUTCFullYear()!==+d[2]||check.getUTCMonth()!==+d[3]-1||check.getUTCDate()!==+d[4]||+d[5]>23||+d[6]>59||+d[7]>59)throw Error('Invalid event timestamp');
  if(!d[8]&&!/TZID=(?:US-Eastern|America\/New_York)/.test(d[1]))throw Error('Unknown calendar timezone');
  const at=d[8]?Date.UTC(+d[2],+d[3]-1,+d[4],+d[5],+d[6],+d[7]):easternTime(+d[2],+d[3],+d[4],+d[5],+d[6]);
  return {title:title.slice(0,180),at,source,url,highImpact:important,timing:'official',consensus:null};
 }).filter(x=>x&&x.at>=now-DAY&&x.at<=now+90*DAY);
 if(!events.some(x=>x.at>now+7*DAY)||!events.some(x=>x.highImpact&&x.at>now))throw Error('Calendar has no current future coverage');
 return events;
}
export function parseFomc(html,now=Date.now()) {
 const months=['January','February','March','April','May','June','July','August','September','October','November','December'],events=[];
 const sections=[...String(html).matchAll(/(20\d{2}) FOMC Meetings[\s\S]*?(?=(?:20\d{2}) FOMC Meetings|$)/g)];
 for(const [section,y] of sections)for(const m of section.matchAll(/class="[^"]*fomc-meeting__month[^"]*"[^>]*>\s*<strong>([A-Za-z]+)<\/strong>[\s\S]*?class="[^"]*fomc-meeting__date[^"]*"[^>]*>(\d{1,2})(?:-(\d{1,2}))?/g)){
  const month=months.indexOf(m[1])+1,day=Number(m[3]||m[2]);if(!month)continue;
  const at=easternTime(+y,month,day,14),blackoutStart=easternTime(+y,month,+m[2]),blackoutEnd=easternTime(+y,month,day+1);
  // The date is official; customary 14:00 ET is an assumption. Block both meeting days.
  if(at>=now-DAY&&at<=now+90*DAY)events.push({title:'FOMC policy decision day',at,source:'Federal Reserve',url:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',highImpact:true,timing:'14:00 ET customary; date verified, time assumed',blackoutStart,blackoutEnd,consensus:null});
 }
 if(!events.some(x=>x.at>now))throw Error('FOMC calendar has no current future coverage');
 return [...new Map(events.map(x=>[x.at,x])).values()];
}
const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
export function tokenEvidence(rows,asset,now=Date.now()) {
 const data=[...new Map((rows||[]).filter(x=>x.asset===asset).map(x=>[Date.parse(x.time),x])).entries()].map(([at,x])=>({at,inflowUsd:number(x.FlowInExUSD),outflowUsd:number(x.FlowOutExUSD),activeAddresses:number(x.AdrActCnt),provisional:/flash|prelim/i.test([x['FlowInExUSD-status'],x['FlowOutExUSD-status']].join(' '))})).filter(x=>Number.isFinite(x.at)&&x.at%DAY===0&&x.at+DAY<=now).sort((a,b)=>a.at-b.at);
 const last=data.at(-1),prior=data.slice(-8,-1),fresh=last&&now-(last.at+DAY)<=36*HOUR;
 if(!fresh)return {available:false,flowAvailable:false,asset,reason:'Daily token evidence stale or unavailable'};
 const activityPrior=prior.map(x=>x.activeAddresses).filter(x=>x!==null&&x>=0),activityMean=activityPrior.reduce((a,b)=>a+b,0)/activityPrior.length;
 const continuous=prior.length===7&&data.slice(-8).every((x,i,a)=>!i||x.at-a[i-1].at===DAY);
 const flowAvailable=continuous&&data.slice(-8).every(x=>x.inflowUsd!==null&&x.outflowUsd!==null&&x.inflowUsd>=0&&x.outflowUsd>=0)&&last.inflowUsd+last.outflowUsd>0;
 return {available:true,flowAvailable,asset,source:'Coin Metrics Community',url:'https://docs.coinmetrics.io/network-data/network-data-overview/exchange/deposits',periodStart:last.at,periodEnd:last.at+DAY,inflowUsd:flowAvailable?last.inflowUsd:null,outflowUsd:flowAvailable?last.outflowUsd:null,netInflowUsd:flowAvailable?last.inflowUsd-last.outflowUsd:null,netFlowRatio:flowAvailable?(last.inflowUsd-last.outflowUsd)/(last.inflowUsd+last.outflowUsd):null,activeAddresses:last.activeAddresses,activityChangePct:continuous&&activityMean>0&&activityPrior.length===7&&last.activeAddresses!==null?(last.activeAddresses/activityMean-1)*100:null,provisional:last.provisional,reason:flowAvailable?null:'Verified exchange-flow coverage unavailable; network activity is not a substitute',scope:'Daily provider-labelled exchange flows, excluding exchange-to-exchange activity; revisable, not live whale tracking'};
}
export function contextGate(candidate,value,now=Date.now()) {
 const reject=reason=>({...candidate,eligible:false,technicalEligible:!!candidate.eligible,reason});
 if(!candidate.eligible)return candidate;
 if(!value?.updatedAt||now-value.updatedAt>2*HOUR||value.updatedAt>now+60000)return reject('Context loading or stale');
 if(!value.economicCalendar?.available)return reject('Official economic-calendar coverage unavailable');
 const event=value.economicCalendar.events.find(e=>e.highImpact&&now>=(e.blackoutStart??e.at-HOUR)&&now<=(e.blackoutEnd??e.at+30*60000));
 if(event)return reject('Economic-event blackout: '+event.title);
 if(!['cryptoNews','globalNews'].every(id=>value.feeds.some(f=>f.id===id&&f.available&&f.items.some(x=>now-x.publishedAt<=48*HOUR))))return reject('Current crypto or global-news coverage unavailable');
 const matcher=new RegExp('\\b(?:'+(NAMES[candidate.symbol]||candidate.symbol.replace(/USDT$/,'').toLowerCase())+')\\b','i');
 const news=value.feeds.flatMap(f=>f.items||[]).filter(x=>now-x.publishedAt<=24*HOUR&&(matcher.test(x.title)||/\b(?:crypto|bitcoin|ethereum|exchange|federal reserve|inflation|oil|war|iran)\b/i.test(x.title))).sort((a,b)=>b.publishedAt-a.publishedAt);
 const flags=news.filter(x=>/\b(?:hack(?:ed)?|exploit(?:ed)?|insolven\w*|bankrupt\w*|withdrawals? (?:halted|suspended)|delist\w*)\b/i.test(x.title));
 if(flags.length)return reject('Headline risk requires manual review: '+flags[0].title);
 const token=value.tokenOnchain?.assets?.[candidate.symbol];
 if(!token?.flowAvailable||![token.periodEnd,token.netFlowRatio].every(Number.isFinite)||Math.abs(token.netFlowRatio)>1||now-token.periodEnd>36*HOUR||token.periodEnd>now)return reject('Verified token-specific exchange flows unavailable or stale');
 if(!value.onchain?.available||now-value.onchain.observedAt>2*DAY)return reject('Global stablecoin supply evidence unavailable or stale');
 if(candidate.direction==='LONG'&&token.netFlowRatio>.2)return reject('Exchange net inflow conflicts with long setup');
 if(candidate.direction==='SHORT'&&token.netFlowRatio<-.2)return reject('Exchange net outflow conflicts with short setup');
 if(token.activityChangePct!==null&&token.activityChangePct< -40)return reject('Network activity materially below seven-day baseline');
 if(candidate.direction==='LONG'&&value.onchain.change7dPct< -1)return reject('Stablecoin supply contraction risk');
 const upcoming=value.economicCalendar.events.filter(e=>e.highImpact&&e.at>now).slice(0,3),nextBlackout=upcoming.map(e=>e.blackoutStart??e.at-HOUR).filter(t=>t>now);
 return {...candidate,technicalEligible:true,entryValidUntil:Math.min(candidate.entryValidUntil,...nextBlackout),reason:candidate.reason+'; calendar, news and on-chain risk checks passed',context:{policy:'context_risk_v1_unvalidated',checkedAt:now,flow:token,stablecoinChange7dPct:value.onchain.change7dPct,upcoming,headlines:news.slice(0,3),newsMethod:'Headline relevance and risk flags only; no directional sentiment forecast',consensusAvailable:false}};
}
export function contextReadiness(value,now=Date.now()) {
 const fresh=!!value?.updatedAt&&now-value.updatedAt<=2*HOUR&&value.updatedAt<=now+60000;
 const news=['cryptoNews','globalNews'].every(id=>value?.feeds?.some(f=>f.id===id&&f.available&&f.items.some(x=>now-x.publishedAt<=48*HOUR)));
 const flowSymbols=Object.entries(value?.tokenOnchain?.assets||{}).filter(([_,t])=>t.flowAvailable&&Number.isFinite(t.periodEnd)&&t.periodEnd<=now&&now-t.periodEnd<=36*HOUR).map(([s])=>s);
 return {ok:fresh&&news&&!!value.economicCalendar?.available&&!!value.onchain?.available&&now-value.onchain.observedAt<=2*DAY&&flowSymbols.length>0,flowSymbols,updatedAt:value?.updatedAt||null};
}
export function createContext(fetcher=fetch,clock=Date.now) {
 const feeds=[['fed','Federal Reserve monetary-policy releases','https://www.federalreserve.gov/feeds/press_monetary.xml'],['usEconomy','US Bureau of Labor Statistics releases','https://www.bls.gov/feed/bls_latest.rss'],['globalNews','BBC macro and business headlines','https://feeds.bbci.co.uk/news/business/rss.xml'],['cryptoNews','CoinDesk headlines','https://www.coindesk.com/arc/outboundfeeds/rss/']];
 const calendarSources=[['BLS','https://www.bls.gov/schedule/news_release/bls.ics'],['BEA','https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics'],['Federal Reserve','https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm']];
 let value={updatedAt:null,feeds:[],onchain:{available:false,reason:'Loading global supply'},tokenOnchain:{available:false,assets:{},flowSymbols:[],reason:'Loading verified daily coverage'},economicCalendar:{available:false,events:[],sources:[],reason:'Loading official schedules'},selectionImpact:'Technical strategy plus mandatory calendar, headline-risk and token exchange-flow gates. Context does not inflate rule scores.'},lastAttempt=0,busy=false,catalog=null,catalogAt=0;
 async function get(url){const r=await fetcher(url,{signal:AbortSignal.timeout(12000),headers:{'user-agent':'crypto-engine-research/1.1'}});if(!r.ok)throw Error('HTTP '+r.status);return r;}
 return {status:()=>structuredClone(value),async refresh(symbols=Object.keys(ASSETS)){
  if(busy||lastAttempt&&clock()-lastAttempt<(value.feeds.some(f=>!f.available)||!value.economicCalendar.available||!value.tokenOnchain.available?900000:HOUR))return;busy=true;lastAttempt=clock();
  try{
   const feedTask=Promise.allSettled(feeds.map(async([id,name,url])=>{let items=parseRss(await(await get(url)).text(),clock());if(id==='globalNews')items=items.filter(x=>/\b(?:inflation|rates?|bank|economy|economic|markets?|stocks?|trade|tariff|oil|energy|war|iran|dollar|fed|GDP|jobs|AI|valuation)\b/i.test(x.title));items=items.slice(0,8);if(!items.length)throw Error('No relevant dated headlines');return {id,name,url,available:true,items,fetchedAt:clock()};}));
   const calendarTask=Promise.allSettled(calendarSources.map(async([source,url])=>{const raw=await(await get(url)).text();return {source,url,available:true,events:source==='Federal Reserve'?parseFomc(raw,clock()):parseCalendar(raw,source,url,clock())};}));
   const supplyTask=(async()=>{try{return stablecoinContext(await(await get('https://stablecoins.llama.fi/stablecoincharts/all')).json(),clock());}catch(e){return {available:false,reason:e.message};}})();
   const tokenTask=(async()=>{try{
    if(!catalog||clock()-catalogAt>DAY){const j=await(await get(CM+'/catalog-v2/asset-metrics?metrics=FlowInExUSD,FlowOutExUSD,AdrActCnt&page_size=1000')).json();if(!Array.isArray(j.data)||j.next_page_token)throw Error('Incomplete public coverage catalog');catalog=j.data;catalogAt=clock();}
    const eligible=Object.entries(ASSETS).filter(([s,a])=>symbols.includes(s)&&catalog.some(x=>x.asset===a));
    const supports=(a,metric)=>catalog.some(x=>x.asset===a&&x.metrics?.some(m=>m.metric===metric&&m.frequencies.some(f=>f.frequency==='1d'&&f.community)));
    const flows=eligible.filter(([_,a])=>supports(a,'FlowInExUSD')&&supports(a,'FlowOutExUSD')&&supports(a,'AdrActCnt')),activity=eligible.filter(([_,a])=>!flows.some(([__,b])=>a===b)&&supports(a,'AdrActCnt'));
    const start=new Date(clock()-10*DAY).toISOString().slice(0,10),rows=[];
    for(const [assets,metrics] of [[flows,'FlowInExUSD,FlowOutExUSD,AdrActCnt'],[activity,'AdrActCnt']]){if(!assets.length)continue;const url=CM+'/timeseries/asset-metrics?'+new URLSearchParams({assets:assets.map(x=>x[1]).join(','),metrics,frequency:'1d',start_time:start,page_size:'1000'});const j=await(await get(url)).json();if(!Array.isArray(j.data)||j.next_page_token)throw Error('Incomplete token timeseries');rows.push(...j.data);}
    const assets=Object.fromEntries(symbols.map(s=>[s,ASSETS[s]?tokenEvidence(rows,ASSETS[s],clock()):{available:false,flowAvailable:false,reason:'No verified provider mapping or public coverage'}]));
    return {available:Object.values(assets).some(x=>x.available),assets,flowSymbols:Object.keys(assets).filter(s=>assets[s].flowAvailable),reason:'Public exchange-flow coverage is limited; missing token flows block final signals. Activity alone is not exchange flow.'};
   }catch(e){return {available:false,assets:{},flowSymbols:[],reason:e.message};}})();
   const [f,c,onchain,tokenOnchain]=await Promise.all([feedTask,calendarTask,supplyTask,tokenTask]);
   const sources=c.map((r,i)=>r.status==='fulfilled'?{source:r.value.source,url:r.value.url,available:true}:{source:calendarSources[i][0],url:calendarSources[i][1],available:false,reason:r.reason.message});
   value={...value,updatedAt:clock(),feeds:f.map((r,i)=>r.status==='fulfilled'?r.value:{id:feeds[i][0],name:feeds[i][1],url:feeds[i][2],available:false,items:[],reason:r.reason.message}),onchain,tokenOnchain,economicCalendar:{available:sources.every(x=>x.available),sources,events:c.flatMap(r=>r.status==='fulfilled'?r.value.events:[]).sort((a,b)=>a.at-b.at).slice(0,100),consensusAvailable:false,reason:sources.every(x=>x.available)?'Official schedules loaded; consensus forecasts unavailable':'Incomplete official calendar coverage',fetchedAt:clock()}};
  }finally{busy=false;}
 }};
}
