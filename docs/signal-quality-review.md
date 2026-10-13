# Signal quality review — 13 October 2026

The pre-release live journal contained six receipts: two TP1 exits, two stops and two open simulations. At 15,000 USDT notional the four completed receipts totaled -233.75 USDT, with profit factor 0.784 and average net P&L -58.44 USDT. H4-led receipts had two TP1 hits and one stop (+494.52 USDT); daily-aligned ONDO had one stop (-728.27 USDT). This is a four-outcome audit, not a backtest or evidence of future profitability.

ONDO's original net TP1/stop reward-risk was 0.938, although the daily-aligned gate used TP2 reward-risk. The journal exits fully at TP1. Version `mtf_tp1_quality_v5` applies the existing H4 net TP1/stop minimum of 1.2 to both families, after tick rounding, fees and slippage. Both now propose 1.5R/2.5R/3.5R targets. Larger daily targets may lower their hit rate; this fixes exit-policy consistency, not a proven win-rate improvement. H4 targets and entry filters are unchanged.

Historical receipts, their levels, outcomes and trigger watermarks are preserved. The new model identifier is displayed in signal details. No RSI cutoff was fitted to this small sample: both a historical winner and loser had low RSI. All market, volume, derivatives, BTC, public context, calendar, cross-venue, freshness and saved-checkpoint requirements remain mandatory. No arbitrary publication cap is introduced.

Profit factor and average P&L are calculated only from retained completed TP1/STOP/TIMEOUT receipts with finite net P&L. Open and unresolved receipts are excluded. Archived receipts remain included in cumulative win-rate and realized totals, but their gain/loss components are not inferred. No-loss and zero-sample cases do not fabricate infinite ratios. Funding remains excluded.

Validation: 123 tests, including both strategy directions and families, TP1 rejection despite passing TP2, preservation of simulation exits, retained metrics, archive scope, display scaling and clickable details; syntax checks. Existing alert, checkpoint and freshness tests remain in the suite. Production deployment and browser checks must be recorded separately.
