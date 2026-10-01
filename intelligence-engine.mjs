function mean(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
function stdev(a){if(a.length<2)return 0;const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)));}
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}

export function createIntelligenceEngine(){
  const books=new Map(), trades=new Map(), prices=new Map();
  function arr(map,id){if(!map.has(id))map.set(id,[]);return map.get(id);}
  function push(map,id,v,max=1200){const a=arr(map,id);a.push(v);if(a.length>max)a.splice(0,a.length-max);}
  function onTrade(id,t){push(trades,id,t); push(prices,id,{t:t.t,p:Number(t.price),side:t.side,qty:Number(t.qty)});}
  function onBook(id,b){books.set(id,b);}
  function features(id){
    const now=Date.now(), ts=(trades.get(id)||[]).filter(x=>now-x.t<=15*60*1000);
    const ps=(prices.get(id)||[]).filter(x=>now-x.t<=15*60*1000);
    const b=books.get(id)||{};
    const ret=(ms)=>{const xs=ps.filter(x=>now-x.t<=ms); if(xs.length<2)return 0;return Math.log(xs.at(-1).p/xs[0].p);};
    const flow=(ms)=>{const xs=ts.filter(x=>now-x.t<=ms);return xs.reduce((s,x)=>s+(x.side==="BUY"?1:-1)*x.qty*x.price,0);};
    const total=(ms)=>ts.filter(x=>now-x.t<=ms).reduce((s,x)=>s+x.qty*x.price,0);
    const r5=ret(5*60*1000), r1=ret(60*1000), r15=ret(15*60*1000);
    const short=ts.filter(x=>now-x.t<=2*60*1000);
    const returns=[]; for(let i=1;i<ps.length;i++){if(ps[i].t-ps[i-1].t<=120000)returns.push(Math.log(ps[i].p/ps[i-1].p));}
    const rv=stdev(returns)*Math.sqrt(Math.max(1,returns.length));
    const f2=flow(2*60*1000),f10=flow(10*60*1000),v2=total(2*60*1000),v10=total(10*60*1000);
    const cvd2=v2?f2/v2:0,cvd10=v10?f10/v10:0;
    const imbalance=Number(b.imbalance)||0, spread=Number(b.spreadBps);
    const alignment=clamp((Math.sign(r5)===Math.sign(cvd10)?1:-1)*(Math.min(1,Math.abs(r5)*100)+Math.min(1,Math.abs(cvd10)*2))/2,-1,1);
    const direction=alignment>0.25?"LONG":alignment<-0.25?"SHORT":"NO TRADE";
    const dataFresh=Boolean(b.updatedAt && now-b.updatedAt<20000 && ps.length>=5);
    const microQuality=dataFresh && Number.isFinite(spread) && spread<12 && Math.abs(imbalance)<0.95;
    const reasonCodes=[];
    if(!dataFresh)reasonCodes.push("STALE_OR_THIN");
    if(Number.isFinite(spread)&&spread>=12)reasonCodes.push("WIDE_SPREAD");
    if(Math.abs(imbalance)>=0.95)reasonCodes.push("ONE_SIDED_BOOK");
    if(Math.sign(r5)!==Math.sign(cvd10)&&Math.abs(r5)>0.0005&&Math.abs(cvd10)>0.15)reasonCodes.push("FLOW_PRICE_CONFLICT");
    if(Math.abs(r5)<0.0003)reasonCodes.push("NO_MATERIAL_MOVE");
    return {horizon:"H1",price:ps.at(-1)?.p??null,return_1m:r1,return_5m:r5,return_15m:r15,realized_vol:rv,
      cvd_2m:cvd2,cvd_10m:cvd10,flow_2m_usd:f2,flow_10m_usd:f10,volume_2m_usd:v2,volume_10m_usd:v10,
      orderbook_imbalance:imbalance,spread_bps:Number.isFinite(spread)?spread:null,alignment,action:microQuality?direction:"NO TRADE",
      data_fresh:dataFresh,microstructure_quality:microQuality,reason_codes:reasonCodes};
  }
  function snapshot(assets){return assets.map(a=>({asset_id:a.id,symbol:a.symbol,...features(a.id)}));}
  return {onTrade,onBook,features,snapshot};
}
