function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegative(value) {
  return Math.max(0, finite(value));
}

export function estimateRoundTripCosts(input = {}) {
  const notionalUsd = nonNegative(input.notionalUsd);
  const entryFeeRate = nonNegative(input.entryFeeRate);
  const exitFeeRate = nonNegative(input.exitFeeRate);
  const entrySlippageBps = nonNegative(input.entrySlippageBps);
  const exitSlippageBps = nonNegative(input.exitSlippageBps);
  const spreadCrossingBps = nonNegative(input.spreadCrossingBps);
  const fundingRateAbs = nonNegative(input.fundingRateAbs);
  const expectedFundingPeriods = nonNegative(input.expectedFundingPeriods);

  const feesUsd = notionalUsd * (entryFeeRate + exitFeeRate);
  const slippageUsd = notionalUsd * ((entrySlippageBps + exitSlippageBps) / 10_000);
  const spreadUsd = notionalUsd * (spreadCrossingBps / 10_000);
  const fundingReserveUsd = notionalUsd * fundingRateAbs * expectedFundingPeriods;
  const totalCostsUsd = feesUsd + slippageUsd + spreadUsd + fundingReserveUsd;

  return {
    notionalUsd,
    feesUsd,
    slippageUsd,
    spreadUsd,
    fundingReserveUsd,
    totalCostsUsd,
    assumptions: {
      entryFeeRate,
      exitFeeRate,
      entrySlippageBps,
      exitSlippageBps,
      spreadCrossingBps,
      fundingRateAbs,
      expectedFundingPeriods
    }
  };
}

export function estimateExpectedNetPnl(input = {}) {
  const expectedGrossUsd = finite(input.expectedGrossUsd);
  const costs = estimateRoundTripCosts(input);
  return {
    expectedGrossUsd,
    expectedNetUsd: expectedGrossUsd - costs.totalCostsUsd,
    costs
  };
}

export function minimumGrossUsdForNetTarget(input = {}) {
  const targetNetUsd = finite(input.targetNetUsd);
  const costs = estimateRoundTripCosts(input);
  return {
    targetNetUsd,
    requiredGrossUsd: targetNetUsd + costs.totalCostsUsd,
    costs
  };
}
