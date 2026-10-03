# Production sign-off

Scope: paper-only crypto signal research for personal swing and positional review. No live order execution.

## Correctness release

- [x] `paper_v3` evaluates persisted timestamps through the first stop or final-target exit.
- [x] Deadline prices exclude later observations; timeout uses the last observation before the deadline only within the 120-second coverage allowance.
- [x] Entry/internal/deadline coverage gaps never generate synthetic outcomes. Expired unassessable trades are retained as INVALID_EVIDENCE.
- [x] Tick reads paginate by observation timestamp and fail closed on incomplete reads.
- [x] Outcome-first writes recover interrupted paper closes without rewriting outcomes.
- [x] Legacy outcomes remain stored but are excluded from readiness.
- [x] H4 and MTF paper positions have independent model slots.
- [x] Five expanding forward windows use signal time, purge overlapping training exits, and freeze training-only probability calibration before each test window.
- [x] Dashboard exposes independent-window and cost-coverage gates.

The forward-window assessment measures recorded decisions for the fixed model; it is not a counterfactual optimized strategy backtest. At least 50 eligible earlier training outcomes and 20 test outcomes in each of five windows are required. Overlapping holding periods may require more than 150 total outcomes.

## Final sign-off remains blocked

- [ ] Verified historical funding settlement coverage. Current outcome cost model includes entry/exit fees, configured slippage and any recorded funding cost, but funding is not accrued. `costCoverageComplete` remains false; no automatic actionable promotion is allowed.
- [ ] Enough complete versioned outcomes independently for H4, D1 and MTF; profitable forward windows and robustness checks, with acceptable drawdown and concentration.
- [ ] Model-specific freshness-gated swing/positional review and qualified setup promotion. Existing actionable publishing remains H1-only.
- [ ] Operational observation and recovery checks against production, including D1 cursor/ignore-duplicate behavior, retention and archive recoverability.

Do not delete legacy data, relabel unverifiable records, reduce evidence thresholds, or enable execution to obtain sign-off. A feed-health LIVE badge does not establish validated model performance. `INVALID_EVIDENCE` is a data-coverage failure, not a winning or losing trade.
