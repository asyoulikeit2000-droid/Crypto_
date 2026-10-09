import { estimateExpectedNetPnl } from "./cost-model.mjs";

export function prepareEconomicIntent(rawIntent = {}, costAssumptions = {}) {
  const requestedNotionalUsd = Number(rawIntent.requestedNotionalUsd || 0);
  const expectedGrossUsd = Number(rawIntent.expectedGrossUsd);
  const economics = Number.isFinite(expectedGrossUsd)
    ? estimateExpectedNetPnl({
        ...costAssumptions,
        notionalUsd: requestedNotionalUsd,
        expectedGrossUsd
      })
    : {
        expectedGrossUsd: null,
        expectedNetUsd: -Infinity,
        costs: null
      };

  return {
    ...rawIntent,
    expectedNetUsd: economics.expectedNetUsd,
    economics
  };
}
