import { initializeTursoFetchShim } from "./storage/fetch-shim.mjs";

process.env.PRIMARY_DB = "turso";
await initializeTursoFetchShim();
await import("./server.mjs");
