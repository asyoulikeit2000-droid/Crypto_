# Automated execution safety boundary

This directory is intentionally isolated from the existing signal/paper-trading engine until live execution has passed validation.

## Non-negotiable invariants

1. Deployment does **not** enable trading. `EXECUTION_MODE` defaults to `disabled`.
2. `live` requires independent enable + acknowledgement gates and exchange credentials.
3. Production live mode additionally requires `LIVE_STRATEGY_VALIDATED=true`.
4. Exchange credentials must live only in the deployment platform secret store. Never commit them, print them, return them through an API, or write them to Turso/R2.
5. API keys used by the bot must have **trade/read only** permissions. Withdrawal permission must remain disabled at the exchange.
6. Restrict the API key to the fixed production egress IP whenever the selected exchange supports IP allowlisting.
7. Any kill switch, stale market data, exchange-health failure, excessive spread, drawdown breach, daily-loss breach, exposure breach, or insufficient expected net edge must fail closed.
8. Stops are protective orders. Saving maker fees is never a reason to suppress an emergency exit.
9. No martingale, loss-chasing, automatic leverage escalation, or automatic risk increase when the six-month P&L target is behind schedule.
10. Every order intent, risk decision, exchange acknowledgement, fill, cancel, exit, fee, funding charge and reconciliation result must eventually be auditable.

## Initial economic gate

The research objective is approximately **$5 realized average net P&L per completed trade**. The initial acceptance floor is deliberately higher: `MIN_EXPECTED_NET_USD=6.50`, leaving room for live degradation from model error, spread, slippage and fee variation.

This is a research/engineering target, not a guaranteed return.
