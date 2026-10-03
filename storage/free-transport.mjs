// Dedicated checkpoint API: compare-and-swap plus a server-enforced two-minute
// write interval prevents overlapping releases from resetting caps or budgets.
export function createFreeTransport({url=process.env.FREE_D1_RELAY_URL,token=process.env.CLOUDFLARE_D1_RELAY_TOKEN,fetcher=fetch}={}) {
  if(!url||!token)throw new Error('Free checkpoint relay credentials missing');
  let blockedUntil=0;
  return {async db(_table,method='GET',_params={},body) {
    if(method!=='GET'&&Date.now()<blockedUntil)throw new Error('D1 write quota exhausted; retry after '+new Date(blockedUntil).toISOString());
    const r=await fetcher(url.replace(/\/$/,'')+'/checkpoint',{method:method==='GET'?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:method==='GET'?undefined:JSON.stringify({data:body.data,expectedSavedAt:body.expectedSavedAt}),signal:AbortSignal.timeout(15000)});
    const j=await r.json();
    if(!r.ok||!j.ok) {
      if(/exceeded.*(?:daily|free tier).*limit/i.test(j.error||'')){const reset=new Date();reset.setUTCHours(24,0,0,0);blockedUntil=reset.getTime();}
      const e=new Error(r.status===409?'Checkpoint changed; recovery required':String(j.error||'Checkpoint HTTP '+r.status));e.conflict=r.status===409;throw e;
    }
    if(method!=='GET'&&!j.data)throw new Error('Missing checkpoint acknowledgement');
    return j.data?[{data:j.data,meta:j.meta}]:[];
  }};
}
