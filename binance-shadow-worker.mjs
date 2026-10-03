import { createTursoCompat } from "./storage/turso-store.mjs";
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

const store=createTursoCompat();
await store.initialize();

const service=createBinanceShadowService({
  db:store.db,
  markHealth:store.markHealth,
  onStatus:event=>{
    const important=["shadowOpened","shadowClosed","performanceError","openInterestError","tickError"];
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
console.log(JSON.stringify({
  service:"binance-shadow-research",
  status:"RUNNING",
  liveOrdersPossible:false,
  symbols:service.state().symbols
}));
