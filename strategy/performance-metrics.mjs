function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mean(xs) {
  return xs.length ? xs.reduce((a,b)=>a+b,0) / xs.length : 0;
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
}

function maxDrawdownPctFromReturns(returns) {
  let equity = 1, peak = 1, maxDd = 0;
  for (const r of returns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  return maxDd;
}

export function summarizeStrategyTrades(trades = [], { recentCount = 100, foldCount = 5 } = {}) {
  const rows = [...trades]
    .filter(x => Number.isFinite(Number(x.netReturn)) || Number.isFinite(Number(x.netBps)))
    .map(x => {
      const netBps = Number.isFinite(Number(x.netBps))
        ? Number(x.netBps)
        : Number(x.netReturn) * 10_000;
      const grossBps = Number.isFinite(Number(x.grossBps))
        ? Number(x.grossBps)
        : Number.isFinite(Number(x.grossReturn)) ? Number(x.grossReturn) * 10_000 : netBps;
      const costBps = Number.isFinite(Number(x.costBps))
        ? Math.max(0, Number(x.costBps))
        : Math.max(0, grossBps - netBps);
      return {
        ...x,
        netBps,
        grossBps,
        costBps,
        netReturn: netBps / 10_000
      };
    })
    .sort((a,b) => String(a.closedAt || a.openedAt || "").localeCompare(String(b.closedAt || b.openedAt || "")));

  const nets = rows.map(x=>x.netBps);
  const wins = rows.filter(x=>x.netBps>0);
  const losses = rows.filter(x=>x.netBps<=0);
  const positive = wins.reduce((s,x)=>s+x.netBps,0);
  const negative = -losses.reduce((s,x)=>s+x.netBps,0);
  const recent = rows.slice(-Math.min(rows.length, Math.max(1, recentCount)));

  const folds = [];
  const fc = Math.max(1, Math.floor(foldCount));
  for (let i=0;i<fc;i++) {
    const from = Math.floor(i * rows.length / fc);
    const to = Math.floor((i+1) * rows.length / fc);
    const slice = rows.slice(from,to);
    if (!slice.length) continue;
    folds.push({
      index:i+1,
      n:slice.length,
      avgNetBps:mean(slice.map(x=>x.netBps)),
      totalNetBps:slice.reduce((s,x)=>s+x.netBps,0)
    });
  }

  const bySymbol = new Map();
  for (const x of rows) {
    const symbol = String(x.symbol || "UNKNOWN").toUpperCase();
    bySymbol.set(symbol, (bySymbol.get(symbol) || 0) + 1);
  }
  const maxSymbolCount = bySymbol.size ? Math.max(...bySymbol.values()) : 0;

  const grossAbs = rows.reduce((s,x)=>s+Math.abs(x.grossBps),0);
  const costs = rows.reduce((s,x)=>s+x.costBps,0);
  const costCoverageRatio = costs > 0 ? grossAbs / costs : (grossAbs > 0 ? Infinity : 0);

  return {
    sampleCount: rows.length,
    recentSampleCount: recent.length,
    winRate: rows.length ? wins.length / rows.length : 0,
    avgNetBps: mean(nets),
    recentAvgNetBps: mean(recent.map(x=>x.netBps)),
    netBpsStdDev: stdev(nets),
    profitFactor: negative > 0 ? positive / negative : (positive > 0 ? Infinity : 0),
    maxDrawdownPct: maxDrawdownPctFromReturns(rows.map(x=>x.netReturn)),
    foldCount: folds.length,
    positiveFolds: folds.filter(x=>x.avgNetBps>0).length,
    folds,
    costCoverageRatio,
    symbolConcentrationPct: rows.length ? maxSymbolCount / rows.length : 1,
    symbols: Object.fromEntries([...bySymbol.entries()].sort((a,b)=>b[1]-a[1]))
  };
}
