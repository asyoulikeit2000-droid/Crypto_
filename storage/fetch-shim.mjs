import { createTursoCompat, tursoConfigured } from "./compat.mjs";

const nativeFetch = globalThis.fetch.bind(globalThis);
let store = null;
let initPromise = null;

export async function initializeTursoFetchShim() {
  if (!tursoConfigured()) throw new Error("Turso credentials not configured");
  if (!initPromise) {
    store = createTursoCompat();
    initPromise = (async () => {
      await store.initialize();
      const ok = await store.healthcheck();
      if (!ok) throw new Error("Turso healthcheck failed");
      await store.markHealth("runtime", "BOOTING", { paperOnly: true, executionEnabled: false });
    })();
  }
  await initPromise;

  const compatBase = "https://turso-compat.invalid";
  process.env.SUPABASE_URL = compatBase;
  process.env.SUPABASE_SECRET_KEY = "turso-compat-local";

  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url;
    if (!rawUrl || !rawUrl.startsWith(compatBase + "/rest/v1/")) {
      return nativeFetch(input, init);
    }

    try {
      const u = new URL(rawUrl);
      const table = decodeURIComponent(u.pathname.slice("/rest/v1/".length));
      const params = Object.fromEntries(u.searchParams.entries());
      const method = String(init.method || "GET").toUpperCase();
      const headers = new Headers(init.headers || {});
      const prefer = headers.get("Prefer") || "";
      let body;
      if (init.body !== undefined && init.body !== null) {
        const text = typeof init.body === "string" ? init.body : String(init.body);
        body = text ? JSON.parse(text) : undefined;
      }
      const result = await store.db(table, method, params, body, { Prefer: prefer });
      return new Response(result?.length || Array.isArray(result) ? JSON.stringify(result) : JSON.stringify(result ?? []), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    } catch (error) {
      return new Response(JSON.stringify({ message: String(error?.message || error) }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  };

  return store;
}
