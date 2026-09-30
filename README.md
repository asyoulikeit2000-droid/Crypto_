# Crypto Intelligence Engine

Private, paper-only crypto market intelligence system.

## Production state

- Live Bybit public-market ingestion through a Supabase Edge Function relay
- Dynamic Top-30 eligible universe
- Live trades, order books, funding, open interest, OHLCV and feature pipeline
- Supabase-backed model calibration, validation, paper trading and audit history
- Railway production runtime with `/api/health`
- Browser dashboard at the Railway production domain
- **No live trade execution**

## Signal safety

The market engine can be operational while the signal model remains in shadow validation.

Actionable signal publishing is blocked unless all of these are true:

1. Calibration status is `ACTIVE`
2. Walk-forward validation is complete
3. The out-of-sample test set has at least 20 observations
4. Out-of-sample average PnL is positive
5. Out-of-sample total PnL is positive

Until those gates pass, the dashboard must show **SHADOW / NOT VALIDATED**.

## Production service

Railway service: `crypto-engine-production`

Health endpoint: `/api/health`

Dashboard API: `/api/dashboard`

## Validation

GitHub Actions validates the Node runtime files and dashboard JavaScript on every push to `main`.

## Operating principle

Market-data uptime is not the same as predictive edge. The system stays paper-only and blocks actionable signals until the model demonstrates positive out-of-sample performance.
