// Bounded, public context. Headlines and stablecoin supply are not token flow or
// validated sentiment signals. They do not silently change the technical score.
export function parseRss(xml,now=Date.now()) {
  const decode=s=>String(s||'').replace(/<!\[CDATA\[|\]\]>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(([_,body])=>{
    const pick=tag=>decode(body.match(new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)<\\/'+tag+'>','i'))?.[1]).trim();
    const title=pick('title'),url=pick('link'),publishedAt=Date.parse(pick('pubDate'));
    return {title,url,publishedAt};
  }).filter(x=>x.title&&/^https:\/\//.test(x.url)&&Number.isFinite(x.publishedAt)&&x.publishedAt<=now+60000).sort((a,b)=>b.publishedAt-a.publishedAt).slice(0,5);
}
export function stablecoinContext(rows,now=Date.now()) {
  const normalized=(Array.isArray(rows)?rows:[]).map(x=>({at:Number(x.date)*1000,usd:Number(x.totalCirculatingUSD?.peggedUSD)})).filter(x=>Number.isFinite(x.at)&&x.at<=now+60000&&x.usd>0).sort((a,b)=>a.at-b.at);
  const last=normalized.at(-1),prior=normalized.filter(x=>last&&x.at<=last.at-7*86400000).at(-1);
  if(!last||now-last.at>2*86400000||!prior)throw new Error('Stablecoin supply evidence stale or incomplete');
  return {available:true,source:'DefiLlama',url:'https://stablecoins.llama.fi/stablecoincharts/all',observedAt:last.at,usdSupply:last.usd,change7dPct:(last.usd/prior.usd-1)*100,scope:'Global USD-pegged stablecoin supply; not asset-specific exchange inflows or whale activity'};
}
export function createContext(fetcher=fetch,clock=Date.now) {
  const feeds=[['fed','Federal Reserve monetary-policy releases','https://www.federalreserve.gov/feeds/press_monetary.xml'],['usEconomy','US Bureau of Labor Statistics releases','https://www.bls.gov/feed/bls_latest.rss'],['globalNews','BBC business headlines','https://feeds.bbci.co.uk/news/business/rss.xml'],['cryptoNews','CoinDesk headlines','https://www.coindesk.com/arc/outboundfeeds/rss/']];
  let value={updatedAt:null,feeds:[],onchain:{available:false,reason:'Loading global stablecoin supply'},tokenOnchain:{available:false,reason:'Asset-specific exchange flows, active addresses and whale activity are not configured'},selectionImpact:'Context for manual review; not included in the rule score',economicCalendar:{available:false,reason:'A verified upcoming-release calendar and consensus forecasts are not configured'}},lastAttempt=0,busy=false;
  async function get(url){const r=await fetcher(url,{signal:AbortSignal.timeout(12000),headers:{'user-agent':'crypto-engine-research/1.0'}});if(!r.ok)throw new Error('HTTP '+r.status);return r;}
  return {status:()=>structuredClone(value),async refresh(){if(busy||lastAttempt&&clock()-lastAttempt<3600000)return;busy=true;lastAttempt=clock();try{
    const results=await Promise.allSettled(feeds.map(async([id,name,url])=>{const items=parseRss(await(await get(url)).text(),clock());if(!items.length)throw new Error('No dated headlines available');return {id,name,url,available:true,items,fetchedAt:clock()};}));
    let onchain;try{onchain=stablecoinContext(await(await get('https://stablecoins.llama.fi/stablecoincharts/all')).json(),clock());}catch(e){onchain={available:false,reason:String(e.message)};}
    value={...value,updatedAt:clock(),feeds:results.map((r,i)=>r.status==='fulfilled'?r.value:{id:feeds[i][0],name:feeds[i][1],url:feeds[i][2],available:false,reason:String(r.reason.message)}),onchain};
  }finally{busy=false;}}};
}
