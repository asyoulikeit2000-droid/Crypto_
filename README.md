# Crypto Intelligence Engine

Private, paper-only crypto market intelligence system.

## Production architecture

- Railway: continuous Node.js engine, API and dashboard
- Turso: primary operational database for signals, outcomes, models, scanner state and recent market history
- Cloudflare Workers: read-only Bybit market-data relay
- Cloudflare R2: compressed archive for rebuildable high-frequency and historical data
- No Supabase runtime dependency
- No live trade execution

## Signal safety

The engine can be operational while signal models remain in shadow validation. Actionable publishing stays blocked until calibration and walk-forward gates pass. H1, H4, D1 and multi-timeframe research remain paper/shadow until their evidence is sufficient.

## Storage policy

Turso retains operational and research-critical records. R2 receives older/rebuildable telemetry in compressed NDJSON objects. Archive deletion only occurs after the R2 object is written and verified.

## Production

Railway service: `crypto-engine-production`

Health: `/api/health`

Dashboard API: `/api/dashboard`

## Validation

GitHub Actions runs syntax checks and Node tests. Production is not considered healthy until Railway readiness confirms the dynamic universe, live trades, live order books and Turso persistence.
