import { estimateRoundTripCosts } from "../execution/cost-model.mjs";

function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function evaluateTradeOutcome({
  side,
  entryPrice,
  exitPrice,
  notionalUsd,
  costAssumptions = {},
  actualFeesUsd,
  actualSlippageUsd,
  actualFundingUsd
} = {}) {
  const entry = finite(entryPrice);
  const exit = finite(exitPrice);
  const notional = finite(notionalUsd);
  const direction = String(side || "").toUpperCase() === "SELL" ? -1 : 1;

  if (!(entry > 0) || !(exit > 0) || !(notional > 0)) {
    return { valid:false, reason:"invalidOutcomeInput" };
  }

  const grossReturn = direction * (exit - entry) / entry;
  const grossUsd = notional * grossReturn;
  const modeled = estimateRoundTripCosts({ ...costAssumptions, notionalUsd:notional });

  const feesUsd = Number.isFinite(Number(actualFeesUsd))
    ? Math.max(0, Number(actualFeesUsd))
    : modeled.feesUsd;
  const slippageUsd = Number.isFinite(Number(actualSlippageUsd))
    ? Math.max(0, Number(actualSlippageUsd))
    : modeled.slippageUsd + modeled.spreadUsd;
  const fundingUsd = Number.isFinite(Number(actualFundingUsd))
    ? Number(actualFundingUsd)
    : modeled.fundingReserveUsd;

  const totalCostsUsd = feesUsd + slippageUsd + fundingUsd;
  const netUsd = grossUsd - totalCostsUsd;
  const grossBps = grossReturn * 10_000;
  const netBps = netUsd / notional * 10_000;
  const costBps = totalCostsUsd / notional * 10_000;

  return {
    valid:true,
    grossReturn,
    grossUsd,
    netUsd,
    grossBps,
    netBps,
    costBps,
    costs:{feesUsd,slippageUsd,fundingUsd,totalCostsUsd},
    usedActuals:{
      fees:Number.isFinite(Number(actualFeesUsd)),
      slippage:Number.isFinite(Number(actualSlippageUsd)),
      funding:Number.isFinite(Number(actualFundingUsd))
    }
  };
}
