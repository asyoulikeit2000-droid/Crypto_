function eqValue(value) {
  const s=String(value ?? "");
  return s.startsWith("eq.") ? s.slice(3) : s;
}

export function createShadowHttpStore({
  baseUrl,
  token,
  fetchImpl=globalThis.fetch
} = {}) {
  const root=String(baseUrl||"").replace(/\/+$/,"");
  if (!root) throw new Error("SHADOW_STORE_URL required");
  if (!token) throw new Error("SHADOW_STORE_TOKEN required");
  if (typeof fetchImpl !== "function") throw new Error("fetch unavailable");

  async function request(path, init={}) {
    const res=await fetchImpl(root+path,{
      ...init,
      headers:{
        "authorization":"Bearer "+token,
        "content-type":"application/json",
        ...(init.headers||{})
      }
    });
    const text=await res.text();
    let data=null;
    try { data=text ? JSON.parse(text) : null; } catch {}
    if (!res.ok || data?.ok === false) {
      throw new Error("shadow store HTTP "+res.status+(data?.error ? ": "+data.error : ""));
    }
    return data;
  }

  async function healthcheck() {
    const data=await request("/health");
    return data?.ok === true;
  }

  async function db(table, method="GET", params={}, body) {
    if (table !== "strategy_trials") throw new Error("shadow HTTP store supports strategy_trials only");
    if (method === "GET") {
      const qs=new URLSearchParams();
      for (const key of ["status","family","symbol","trial_id"]) {
        if (params?.[key] != null) qs.set(key,eqValue(params[key]));
      }
      if (params?.order) qs.set("order",String(params.order));
      if (params?.limit) qs.set("limit",String(params.limit));
      const data=await request("/trials"+(qs.size ? "?"+qs.toString() : ""));
      return Array.isArray(data?.rows) ? data.rows : [];
    }
    if (method === "POST") {
      await request("/trials",{method:"POST",body:JSON.stringify(body)});
      return [];
    }
    throw new Error("unsupported shadow HTTP store method "+method);
  }

  async function markHealth() {
    return true;
  }

  return { db,healthcheck,markHealth,backend:"cloudflare-d1-http" };
}
