function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function evaluatePortfolioAdmission(candidate = {}, portfolio = {}, policy = {}) {
  const failed = [];
  const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
  const maxPositions = Math.max(1, Math.floor(finite(policy.maxOpenPositions, 2)));
  const maxDirectionalNotionalPct = finite(policy.maxDirectionalNotionalPct, 1.25);
  const equityUsd = finite(portfolio.equityUsd);
  const candidateNotional = finite(candidate.notionalUsd);
  const side = String(candidate.side || "").toUpperCase();

  if (positions.length >= maxPositions) failed.push("maxOpenPositions");
  if (!(equityUsd > 0)) failed.push("equityUnavailable");
  if (!(candidateNotional > 0)) failed.push("candidateNotional");

  const sameDirection = positions
    .filter(p => String(p.side || "").toUpperCase() === side)
    .reduce((sum,p) => sum + Math.max(0, finite(p.notionalUsd)), 0);

  const directionalPct = equityUsd > 0 ? (sameDirection + candidateNotional) / equityUsd : Infinity;
  if (directionalPct > maxDirectionalNotionalPct) failed.push("directionalConcentration");

  const symbols = new Set(positions.map(p => String(p.symbol || "").toUpperCase()));
  if (symbols.has(String(candidate.symbol || "").toUpperCase())) failed.push("duplicateSymbol");

  return {
    allowed: failed.length === 0,
    failed,
    metrics: { openPositions: positions.length, directionalPct }
  };
}
