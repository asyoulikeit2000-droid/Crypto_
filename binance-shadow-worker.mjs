import { createTursoCompat } from "./storage/turso-store.mjs";
import { createShadowHttpStore } from "./storage/shadow-http-store.mjs";
import { createBinanceShadowService } from "./research/binance-shadow-service.mjs";

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

const service=createBinanceShadowService({
  db:store.db,
  markHealth:store.markHealth,
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
    shadowEquityUsd:s.runner?.equityUsd ?? null
  }));
},60000);
