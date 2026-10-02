import { initializeTursoFetchShim } from "./storage/fetch-shim.mjs";
import { startArchiveLoop } from "./storage/archive-loop.mjs";

process.env.PRIMARY_DB = "turso";
const store = await initializeTursoFetchShim();
startArchiveLoop(store);
await import("./server.mjs");
