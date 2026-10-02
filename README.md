# Crypto Intelligence Engine

Private, paper-only crypto market intelligence system.

## Production architecture

- **Railway** — continuous Node.js intelligence engine, API and dashboard
- **Turso** — primary operational database for signals, outcomes, models, scanner state and recent history
- **Cloudflare Worker** — Bybit market relay, explicitly placed near AWS Singapore
- **Cloudflare R2** — raw market archive written directly by the Worker through an R2 binding
- **No Supabase runtime dependency**
- **No live trade execution**

## Free-tier storage strategy

Cloudflare samples one raw multi-symbol market snapshot per minute into R2. Turso retains research-critical data indefinitely (signals, signal outcomes, paper trades, model versions/calibration) while bounded retention removes rebuildable high-frequency telemetry.

Current hot retention:
- trades/order books: 4 hours
- features/regimes/data-quality/market ticks: 48 hours
- 1m OHLCV: 14 days
- scanner market snapshots: 7 days
- scanner evaluations: 30 days

## Signal safety

Actionable publishing remains blocked until calibration and walk-forward validation gates pass. H1, H4, D1 and multi-timeframe models remain paper/shadow until evidence is sufficient.

## Validation

Railway builds run syntax checks and the Node test suite before deployment. Production health requires a dynamic universe, live trades, live order books and fresh Turso persistence.
