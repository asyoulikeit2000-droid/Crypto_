const BASE="https://api.dexscreener.com";
const timeoutMs=Number(process.env.SCANNER_PROVIDER_TIMEOUT_MS||8000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function request(path,retries=2){
  let last;
  for(let i=0;i<=retries;i++){
    const c=new AbortController(),t=setTimeout(()=>c.abort(),timeoutMs);
    try{
      const r=await fetch(BASE+path,{headers:{accept:"application/json"},signal:c.signal});
      if(r.status===429||r.status>=500){last=new Error("DexScreener HTTP "+r.status); if(i<retries){await sleep(300*2**i);continue;}}
      if(!r.ok) throw new Error("DexScreener HTTP "+r.status);
      return await r.json();
    }catch(e){last=e;if(i<retries)await sleep(300*2**i);}
    finally{clearTimeout(t);}
  }
  throw last;
}
export async function discoverLatestProfiles(){return request("/token-profiles/latest/v1");}
export async function discoverBoostedTokens(){return request("/token-boosts/top/v1");}
export async function tokenPairs(chainId,tokenAddress){
  return request("/token-pairs/v1/"+encodeURIComponent(chainId)+"/"+encodeURIComponent(tokenAddress));
}
export function normalizePair(pair,now=Date.now()){
  const tx=pair?.txns||{},vol=pair?.volume||{},chg=pair?.priceChange||{};
  const created=Number(pair?.pairCreatedAt||0);
  return {
    provider:"DEXSCREENER",chainId:pair?.chainId||null,pairAddress:pair?.pairAddress||null,dexName:pair?.dexId||null,
    tokenAddress:pair?.baseToken?.address||null,tokenName:pair?.baseToken?.name||null,tokenSymbol:pair?.baseToken?.symbol||null,
    quoteToken:pair?.quoteToken||null,priceUsd:Number(pair?.priceUsd)||null,liquidityUsd:Number(pair?.liquidity?.usd)||null,
    marketCap:Number(pair?.marketCap)||null,fdv:Number(pair?.fdv)||null,
    volume1h:Number(vol.h1)||null,volume6h:Number(vol.h6)||null,volume24h:Number(vol.h24)||null,
    buys1h:Number(tx.h1?.buys)||null,sells1h:Number(tx.h1?.sells)||null,buys24h:Number(tx.h24?.buys)||null,sells24h:Number(tx.h24?.sells)||null,
    priceChange1h:Number(chg.h1)||null,priceChange6h:Number(chg.h6)||null,priceChange24h:Number(chg.h24)||null,
    pairCreatedAt:created?new Date(created).toISOString():null,pairAgeHours:created?(now-created)/36e5:null,
    imageUrl:pair?.info?.imageUrl||null,websites:pair?.info?.websites||[],socials:pair?.info?.socials||[],
    sourceTimestamp:new Date(now).toISOString(),sourceAgeSec:0,providerCount:1,raw:pair
  };
}
