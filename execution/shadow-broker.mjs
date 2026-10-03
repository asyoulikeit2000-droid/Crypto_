import { evaluateTradeIntent } from "./risk-engine.mjs";
import { evaluateVenueAlignment, makeClientOrderId } from "./venue-policy.mjs";
import { transitionOrder } from "./order-state.mjs";
import { prepareEconomicIntent } from "./economics.mjs";

export function createShadowBroker({ config, costAssumptions = {}, onDecision = () => {} } = {}) {
  let nonce = 0;

  return {
    mode: "shadow",
    async submit({ intent, account, market }) {
      const economicIntent = prepareEconomicIntent(intent, costAssumptions);
      const clientOrderId = makeClientOrderId("shadow", Date.now(), ++nonce);
      const base = {
        clientOrderId,
        state: "INTENT",
        createdAt: new Date().toISOString(),
        history: [],
        intent: {
          symbol: economicIntent?.symbol || null,
          side: economicIntent?.side || null,
          requestedNotionalUsd: Number(economicIntent?.requestedNotionalUsd || 0),
          expectedGrossUsd: Number(economicIntent?.expectedGrossUsd || 0),
          expectedNetUsd: Number(economicIntent?.expectedNetUsd || 0)
        }
      };

      const venue = evaluateVenueAlignment({
        executionExchange: config?.exchange,
        marketExchange: market?.exchange,
        bookExchange: market?.bookExchange || market?.exchange,
        crossVenueAllowed: false
      });
      const risk = evaluateTradeIntent(economicIntent, account, market, config);
      const failed = [...venue.failed, ...risk.failed];

      const order = transitionOrder(
        base,
        failed.length ? "REJECTED" : "APPROVED",
        { venueFailed: venue.failed, riskFailed: risk.failed }
      );

      const decision = {
        accepted: failed.length === 0,
        shadowOnly: true,
        clientOrderId,
        order,
        failed,
        venue,
        risk,
        economics: economicIntent.economics
      };
      await onDecision(decision);
      return decision;
    }
  };
}
