# Free MTF profile

The opt-in `ENGINE_PROFILE=free_mtf` profile replaces high-frequency row persistence with one bounded atomic checkpoint. The legacy profile and existing history remain intact for reference; legacy raw writers, scanner, retention and calibration jobs never start in this profile. Trading Bot is a separate service and is unchanged.

## Storage budget and recovery

- One complete checkpoint at most every 120 seconds: 720 successful writes/day, enforced at the database boundary as well as in the process. CAS rejects stale revisions, including overlapping deployments. A successful read cannot manufacture a write acknowledgement.
- Existing D1 `kv_rows` has five indexes. Budget a conservative 11 billed row writes per document replacement: approximately 7,920/day, not 720 billed rows. Failed/conflicting attempts and other services also consume resources; this is not a guarantee of account-wide capacity. Inspect actual D1 metadata/analytics after recovery.
- Maximum document 1.4 MB; maximum 12 markets, 220 closed candles each H1/H4/D1, 170 signal records. Signals retained 30 days; open paper records retained to resolution. Fixed key means no unbounded row growth or daily delete job. Bound failures block saving and publication.
- Quotes/books/recent trades and diagnostics stay in memory. Restart loads the last complete checkpoint and re-fetches market history. Paper cursor and daily signal ledger are checkpointed together. A failed recovery never starts a new empty ledger.
- Engine-only checkpoint Worker uses a fixed namespace/key, the existing D1 database, and the existing engine token hash. It has no generic table or SQL endpoint. Shared storage and market Workers are unchanged.
- Quota errors pause writes until 00:00 UTC. Reads and the dashboard remain available. New setups are shown only after persistence acknowledges the complete checkpoint. Existing setups age visibly.
- `/api/live` is process liveness for rollout; `/api/health` and `/api/ready` return 503 while feeds/persistence are not ready. Do not use rollout success as evidence of storage or strategy readiness.

## Selection contract

Rule model `mtf_free_closed_v1`, paper review only; no exchange order credentials or execution path.

- Liquid Bybit USDT perpetuals, at least $50m 24-hour turnover, up to 12 assets. Open-paper assets retain coverage. No pre-rally small-cap stream.
- 200+ continuous, current closed candles on every timeframe. Daily and H4 EMA20/50 direction/slope must agree with H1; altcoins must not oppose BTC D1/H4 direction.
- H1 close breaks the prior 20-bar extreme, directional candle, volume >=1.2x prior mean. Book/trade/receipt timestamps each <=90 seconds, spread <=6 bps. No late chasing: current price within 0.35 H1 ATR of signal close, at most 3 ATR from EMA20.
- Current funding absolute rate <=0.05% per settlement, fresh OI with approximately one-hour change >=-1.5%. Missing derivatives block qualification. These are transparent filters, not evidence of predictive edge.
- Structural six-bar stop plus 0.2 ATR buffer; distance 0.4–5%, at least 1.2 ATR. Targets 1R, 2R, 3R; net TP2/stop scenario >=1.6 after modeled fees and slippage. Rule agreement score >=80/100. Score is not a win probability.
- Maximum five per Dubai day (UTC+4); at most two per review; >=one hour between selected batches; no same-symbol repeat within a day or while its paper record is open. Zero is allowed. Entry reference valid one hour; paper observation horizon 48 hours.
- The design seeks selectivity; it does not guarantee 3–5 opportunities daily or profitability. It uses market/technical/derivatives history, not unimplemented news, on-chain or fundamental research.

## P&L and evidence

Dashboard scenario notional defaults to $1,000 and is editable. Each stop/target is a separate full-position exit, not a scale-out policy. Fees 0.055% per side and slippage 0.015% per side; funding excluded because future settlements are unknown. Statistical expected P&L and win probability remain null.

Paper monitor uses closed one-minute candles, stop-first when stop and TP3 occur in the same candle, adverse open fill for a gap through stop, and invalidates missing paths or ambiguous entry-minute hits. Only terminal stop/TP3/timeout closes a record; TP1/TP2 are scenario levels. These are modeled observations, not actual fills, and funding-incomplete outcomes must not be advertised as validated performance. No automatic promotion into the old production gate.

Final strategy signoff requires sufficient out-of-sample/forward observations, historical funding attribution, conservative full costs, and verified positive robustness across regimes. A software release cannot supply that evidence on day one.

## Release and rollback

Set only on main engine service:

```
ENGINE_PROFILE=free_mtf
FREE_MARKET_RELAY_URL=https://crypto-engine-free-market.asyoulikeit2000.workers.dev
FREE_D1_RELAY_URL=https://crypto-engine-free-checkpoint.asyoulikeit2000.workers.dev
```

Keep existing `CLOUDFLARE_D1_RELAY_TOKEN`. Market Worker Singapore placement, no R2 binding; checkpoint Worker D1 `DB` and `ENGINE_TOKEN_HASH` bindings. Railway one replica, manual release watch pattern, start `node server.mjs`, liveness path `/api/live`. Both Workers have source in this repository. Do not change the bot service.

Rollback should keep Free persistence and select a prior Free release. Returning to the legacy profile re-enables quota-heavy writers and is not a safe Free-tier rollback. Old research records were not deleted or imported as validated outcomes into the new model.

## References

- D1 pricing and indexed rows: https://developers.cloudflare.com/d1/platform/pricing/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Bybit candles (unclosed closePrice is latest trade): https://bybit-exchange.github.io/docs/v5/market/kline
- Bybit funding history: https://bybit-exchange.github.io/docs/v5/market/history-fund-rate
