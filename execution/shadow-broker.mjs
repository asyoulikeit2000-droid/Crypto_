import { evaluateTradeIntent } from "./risk-engine.mjs";
import { evaluateVenueAlignment, makeClientOrderId } from "./venue-policy.mjs";
import { transitionOrder } from "./order-state.mjs";

export function createShadowBroker({ config, onDecision = () => {} } = {}) {
  let nonce = 0;

  return {
    mode: "shadow",
    async submit({ intent, account, market }) {
      const clientOrderId = makeClientOrderId("shadow", Date.now(), ++nonce);
      const base = {
        clientOrderId,
        state: "INTENT",
        createdAt: new Date().toISOString(),
        history: [],
        intent: {
          symbol: intent?.symbol || null,
          side: intent?.side || null,
          requestedNotionalUsd: Number(intent?.requestedNotionalUsd || 0),
          expectedNetUsd: Number(intent?.expectedNetUsd || 0)
        }
      };

      const venue = evaluateVenueAlignment({
        executionExchange: config?.exchange,
        marketExchange: market?.exchange,
        bookExchange: market?.bookExchange || market?.exchange,
        crossVenueAllowed: false
      });
      const risk = evaluateTradeIntent(intent, account, market, config);
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
        risk
      };
      await onDecision(decision);
      return decision;
    }
  };
}
