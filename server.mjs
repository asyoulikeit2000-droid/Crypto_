import http from "node:http";
import WebSocket from "node:stream/web";
const PORT=Number(process.env.PORT||3000), HOST=process.env.HOST||"0.0.0.0";
const SB=(process.env.SUPABASE_URL||"").replace(/\/$/,""), KEY=process.env.SUPABASE_SECRET_KEY||"", SCHEMA=process.env.SUPABASE_DB_SCHEMA||"engine";
const state={startedAt:new Date().toISOString(),lastTrade:null,lastBook:null,lastDeriv:null,assets:[],errors:[],counts:{trades:0,books:0,derivatives:0}};
async function sb(table,method="GET",params={},body){
 if(!SB||!KEY) throw Error("Supabase credentials not configured");
 const u=new URL(SB+"/rest/v1/"+table); for(const [k,v] of Object.entries(params))u.searchParams.set(k,String(v));
 const h={apikey:KEY,Authorization:"Bearer "+KEY,"Accept-Profile":SCHEMA}; if(method!=="GET"){h["Content-Type"]="application/json";h["Content-Profile"]=SCHEMA;h.Prefer="return=minimal"}
 const r=await fetch(u,{method,headers:h,body:body?JSON.stringify(body):undefined}); if(!r.ok)throw Error("Supabase "+r.status+" "+await r.text()); const t=await r.text(); return t?JSON.parse(t):[];
}
async function status(status,message){try{await sb("provider_status","POST",{on_conflict:"provider,dataset"},{provider:"BINANCE",dataset:"engine",checked_at:new Date().toISOString(),status,last_event_at:new Date().toISOString(),error_message:message||null,metadata:{}})}catch(e){state.errors.push(e.message);state.errors=state.errors.slice(-10)}}
async function universe(){
 const r=await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false"); if(!r.ok)throw Error("CoinGecko "+r.status); const a=(await r.json()).filter(x=>!x.symbol?.includes("usd")&&!x.name?.toLowerCase().includes("wrapped")).slice(0,30);
 for(const x of a){try{await sb("assets","POST",{on_conflict:"asset_id"},{asset_id:x.id,symbol:x.symbol.toUpperCase(),name:x.name,base_asset:x.symbol.toUpperCase(),quote_asset:"USD",asset_type:"spot",active:true,last_seen_at:new Date().toISOString(),metadata:{rank:x.market_cap_rank,market_cap_usd:x.market_cap,current_price:x.current_price}})}catch(e){state.errors.push(e.message)}}
 state.assets=a.map(x=>({id:x.id,symbol:x.symbol.toUpperCase(),rank:x.market_cap_rank})); return a;
}
async function connect(){
 const syms=state.assets.map(x=>x.symbol.toLowerCase()+"usdt").slice(0,30);
 const streams=syms.flatMap(s=>[s+"@trade",s+"@depth20@100ms"]);
 const url="wss://fstream.binance.com/stream?streams="+streams.join("/");
 const ws=new globalThis.WebSocket(url); ws.onopen=()=>status("LIVE","streams connected"); ws.onclose=()=>{status("STALE","websocket closed");setTimeout(connect,5000)}; ws.onerror=()=>status("DELAYED","websocket error");
 ws.onmessage=async ev=>{try{const m=JSON.parse(ev.data).data,sym=m.s?.toUpperCase(),asset=state.assets.find(x=>x.symbol+"USDT"===sym);if(!asset)return;const now=new Date().toISOString();
 if(m.e==="trade"){state.lastTrade=now;state.counts.trades++;await sb("trades","POST",{},{asset_id:asset.id,exchange:"BINANCE",trade_id:String(m.t),observed_at:new Date(m.T).toISOString(),price:Number(m.p),quantity:Number(m.q),side:m.m?"SELL":"BUY",is_buyer_maker:!!m.m,status:"LIVE",metadata:{symbol:sym,received_at:now}})}
 else if(m.e==="depthUpdate"){const b=m.b?.[0],a=m.a?.[0];if(!b||!a)return;const bp=Number(b[0]),bq=Number(b[1]),ap=Number(a[0]),aq=Number(a[1]),mid=(bp+ap)/2,imb=(bq-aq)/(bq+aq||1),sp=(ap-bp)/mid*10000;state.lastBook=now;state.counts.books++;await sb("orderbook_snapshots","POST",{},{asset_id:asset.id,exchange:"BINANCE",observed_at:new Date(m.E).toISOString(),best_bid:bp,best_ask:ap,spread_bps:sp,bid_depth:bp*bq,ask_depth:ap*aq,imbalance:imb,depth_levels:20,status:"LIVE",metadata:{symbol:sym,received_at:now}})}
 }catch(e){state.errors.push(e.message);state.errors=state.errors.slice(-10)}}}
}
async function derivatives(){
 for(const a of state.assets.slice(0,30)){try{const r=await fetch("https://fapi.binance.com/fapi/v1/premiumIndex?symbol="+a.symbol+"USDT");if(!r.ok)continue;const x=await r.json(),now=new Date().toISOString();await sb("funding","POST",{},{asset_id:a.id,exchange:"BINANCE",observed_at:now,funding_rate:Number(x.lastFundingRate),next_funding_at:new Date(Number(x.nextFundingTime)).toISOString(),mark_price:Number(x.markPrice),index_price:Number(x.indexPrice),status:"LIVE"});state.lastDeriv=now;state.counts.derivatives++}catch(e){state.errors.push(e.message)}}
}
async function main(){await status("CONNECTING","boot");await universe();await connect();await derivatives();setInterval(()=>universe().catch(e=>status("DELAYED",e.message)),10*60*1000);setInterval(()=>derivatives(),60*1000);setInterval(()=>status(state.lastTrade&&Date.now()-Date.parse(state.lastTrade)<15000?"LIVE":"STALE","heartbeat"),15000)}
const server=http.createServer(async(req,res)=>{res.setHeader("content-type","application/json");res.setHeader("cache-control","no-store");if(req.url==="/api/health")return res.end(JSON.stringify({ok:true,mode:"live",startedAt:state.startedAt,assets:state.assets.length,lastTrade:state.lastTrade,lastBook:state.lastBook,lastDeriv:state.lastDeriv,counts:state.counts,errors:state.errors.slice(-5)}));if(req.url==="/api/market")return res.end(JSON.stringify({assets:state.assets,counts:state.counts,lastTrade:state.lastTrade,lastBook:state.lastBook,lastDeriv:state.lastDeriv}));res.statusCode=404;res.end(JSON.stringify({error:"not_found"}))});
server.listen(PORT,HOST,()=>main().catch(e=>status("UNAVAILABLE",e.message)));
process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
