import { summarizeStrategyTrades } from "../strategy/performance-metrics.mjs";

function key(v,fallback="UNKNOWN"){ return String(v||fallback).toUpperCase(); }

function groupPush(map,k,row){
  const arr=map.get(k)||[];
  arr.push(row);
  map.set(k,arr);
}

function summarizeMap(map, options){
  return Object.fromEntries([...map.entries()].map(([k,rows])=>[
    k,
    summarizeStrategyTrades(rows,options)
  ]));
}

export function buildPerformanceProfile(trades = [], options = {}) {
  const normalized=(trades||[])
    .filter(x=>x && x.family)
    .map(x=>({
      ...x,
      family:String(x.family),
      symbol:key(x.symbol),
      regime:key(x.regime),
      side:key(x.side)
    }));

  const families=new Map();
  const symbolGroups=new Map();
  const regimeGroups=new Map();
  const contextGroups=new Map();

  for(const row of normalized){
    groupPush(families,row.family,row);
    groupPush(symbolGroups,`${row.family}|${row.symbol}`,row);
    groupPush(regimeGroups,`${row.family}|${row.regime}`,row);
    groupPush(contextGroups,`${row.family}|${row.symbol}|${row.regime}`,row);
  }

  return {
    sampleCount:normalized.length,
    families:summarizeMap(families,options),
    symbols:summarizeMap(symbolGroups,options),
    regimes:summarizeMap(regimeGroups,options),
    contexts:summarizeMap(contextGroups,options)
  };
}

export function getContextStats(profile = {}, {family,symbol,regime} = {}) {
  const f=String(family||"");
  const s=key(symbol);
  const r=key(regime);
  return {
    global:profile?.families?.[f] || null,
    symbol:profile?.symbols?.[`${f}|${s}`] || null,
    regime:profile?.regimes?.[`${f}|${r}`] || null,
    context:profile?.contexts?.[`${f}|${s}|${r}`] || null
  };
}
