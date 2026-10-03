import { createTursoCompat } from "./storage/turso-store.mjs";
import { createShadowHttpStore } from "./storage/shadow-http-store.mjs";
import { createBinanceShadowService } from "./research/binance-shadow-service.mjs";
import { resolveBinanceResearchUniverse } from "./market/binance-research-universe.mjs";

function enabled(value) {
  return String(value||"").trim().toLowerCase()==="true";
}

if (!enabled(process.env.SHADOW_RESEARCH_ENABLED)) {
  console.log(JSON.stringify({
    service:"binance-shadow-research",
    status:"DISABLED",
    reason:"SHADOW_RESEARCH_ENABLED is not true",
    liveOrdersPossible:false
  }));
  process.exit(0);
}

const useRemoteStore=Boolean(process.env.SHADOW_STORE_URL && process.env.SHADOW_STORE_TOKEN);
const store=useRemoteStore
  ? createShadowHttpStore({
      baseUrl:process.env.SHADOW_STORE_URL,
      token:process.env.SHADOW_STORE_TOKEN
    })
  : createTursoCompat();

if (typeof store.initialize === "function") await store.initialize();
if (!(await store.healthcheck())) throw new Error("shadow research storage healthcheck failed");

let runtimeEnv={...process.env};
if (enabled(process.env.SHADOW_DYNAMIC_UNIVERSE_ENABLED)) {
  try {
    const ranked=await resolveBinanceResearchUniverse({
      maxAssets:Number(process.env.SHADOW_UNIVERSE_MAX_ASSETS || 10),
      pinned:String(process.env.SHADOW_UNIVERSE_PINNED || "BTCUSDT").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean),
      minQuoteVolumeUsd:Number(process.env.SHADOW_UNIVERSE_MIN_QUOTE_VOLUME_USD || 25000000),
      maxSpreadBps:Number(process.env.SHADOW_UNIVERSE_MAX_SPREAD_BPS || 8)
    });
    if (ranked.length >= 4) {
      runtimeEnv.SHADOW_SYMBOLS=ranked.map(x=>x.symbol).join(",");
      console.log("shadow_universe_selected "+JSON.stringify({
        service:"binance-shadow-research",
        dynamic:true,
        symbols:ranked.map(x=>x.symbol),
        rankings:ranked
      }));
    } else {
      console.log("shadow_universe_fallback "+JSON.stringify({
        service:"binance-shadow-research",
        reason:"too_few_dynamic_symbols",
        dynamicCount:ranked.length,
        fallbackSymbols:String(process.env.SHADOW_SYMBOLS||"BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT").split(",")
      }));
    }
  } catch (error) {
    console.log("shadow_universe_fallback "+JSON.stringify({
      service:"binance-shadow-research",
      reason:"dynamic_universe_error",
      error:String(error?.message||error).slice(0,300)
    }));
  }
}

const service=createBinanceShadowService({
  db:store.db,
  markHealth:store.markHealth,
  env:runtimeEnv,
  onStatus:event=>{
    const important=["shadowOrderPlaced","shadowOrderExpired","shadowOpened","shadowClosed","shadowRecovered","recoveryError","recoveryDuplicateOpen","researchRanking","performanceError","openInterestError","tickError"];
    if (important.includes(event?.event)) {
      console.log(JSON.stringify({service:"binance-shadow-research",...event}));
    }
  }
});

async function shutdown(signal) {
  try {
    await service.stop();
    console.log(JSON.stringify({service:"binance-shadow-research",status:"STOPPED",signal}));
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT",()=>shutdown("SIGINT"));

await service.start();
console.log("shadow_worker_running "+JSON.stringify({
  service:"binance-shadow-research",
  status:"RUNNING",
  liveOrdersPossible:false,
  symbols:service.state().symbols,
  storageBackend:store.backend
}));

setInterval(()=>{
  const s=service.state();
  const symbolFreshness={};
  for (const [symbol,row] of Object.entries(s.lastFeedStatus?.symbols || {})) {
    symbolFreshness[symbol]={
      tradeFresh:Boolean(row.tradeFresh),
      bookFresh:Boolean(row.bookFresh),
      markFresh:Boolean(row.markFresh)
    };
  }
  console.log("shadow_heartbeat "+JSON.stringify({
    service:"binance-shadow-research",
    liveOrdersPossible:false,
    feedHealthy:s.lastFeedStatus?.healthy === true,
    connected:s.lastFeedStatus?.connected ?? null,
    expectedConnections:s.lastFeedStatus?.expectedConnections ?? null,
    symbolFreshness,
    openTrials:s.runner?.openTrials?.length || 0,
    pendingOrders:s.runner?.pendingOrders?.length || 0,
    makerAttempts:s.runner?.executionQualityProfile?.attempts?.attemptCount || 0,
    completedMakerAttempts:s.runner?.executionQualityProfile?.attempts?.completedCount || 0,
    makerFillRate:s.runner?.executionQualityProfile?.attempts?.fillRate ?? null,
    makerFilledPerDay:s.runner?.executionQualityProfile?.attempts?.filledPerDay || 0,
    fillStats:s.runner?.fillStats || {},
    shadowEquityUsd:s.runner?.equityUsd ?? null
  }));
},60000);
