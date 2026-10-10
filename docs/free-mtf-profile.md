# Manual MTF context profile

`ENGINE_PROFILE=free_mtf` serves manual-entry research only. No exchange account credentials, order submission, paper monitoring, raw tick persistence or legacy calibration jobs start in this profile. The bot and historical records remain separate.

## Scan and strategies

Model `mtf_free_tiers_v3` scans up to 30 liquid Bybit USDT crypto perpetuals, at least $50m daily turnover. Stocks, commodities, forex and stablecoins are excluded. Instruments provide the exchange tick size; missing price rules block qualification.

Both strategies require 200+ continuous, current, closed H1/H4/D1 candles; EMA20/50 direction and slope alignment; altcoin alignment with BTC; fresh book/trade/receipt times <=90 seconds; spread <=6 bps; funding absolute rate <=0.05%; and fresh open interest with roughly one-hour change >=-1.5%.

- Trend breakout: a directional H1 close outside the prior 20-bar extreme, volume >=1.2 times the prior mean.
- Trend pullback: the same higher-timeframe trend, a recent touch of H1 EMA20, a directional recovery above/below the previous close and EMA20 within one ATR, and the same volume threshold.

Structural six-bar stop plus 0.2 ATR buffer; stop distance 0.4–5%, at least 1.2 ATR. Entry rounds toward the adverse fill direction, stop away from entry, targets conservatively toward entry. Recheck rounded risk and net TP2/stop scenario >=1.6 after modeled costs. Score >=80 ranks technical agreement and is never a win probability. TP1/TP2/TP3 approximate 1R/2R/3R after rounding.

At most four per Dubai day, two per batch, one hour between batches, and one signal per asset/day. The entry window is at most one hour and is shortened before an upcoming event blackout. A stale feed, failed checkpoint, missing context, expired window or price outside the narrow entry zone prevents actionable status. Observed price reaching stop or TP1 cancels the entry and is not a tracked trade outcome. Intracycle excursions may be missed; users must independently check the current market and their own fills.

## Context gates and source coverage

Context refreshes hourly; partial provider failures permit retries no more often than every 15 minutes. Fixed public URLs, source attribution and dated snapshots are used; no LLM tokens, paid APIs or additional D1 context rows are required.

Official BLS and BEA ICS calendars and the Fed FOMC meeting calendar supply upcoming release dates. Eastern daylight saving time is converted to UTC and displayed in Dubai time. Major releases block new entries one hour before through 30 minutes after. FOMC calendar dates are official, but customary 14:00 ET release time is labelled an assumption; both meeting days are blocked. All three calendar sources must parse successfully. Consensus forecasts, comprehensive Fed speeches and every geopolitical event are not covered.

Fed/BLS releases, relevant BBC business/macro headlines and CoinDesk headlines provide news evidence. Crypto and macro news must be current. Relevant hack, exploit, insolvency, bankruptcy, halted withdrawal and delisting headlines veto automatic qualification for manual review. This is a conservative headline rule, not semantic news analysis or directional sentiment forecasting; false positives and missed events remain possible. News never increases the technical score.

Coin Metrics Community catalog is checked before requesting daily metrics. Public exchange deposits and withdrawals currently cover BTC and ETH. Other verified tokens may have active-address counts, but activity never substitutes for missing exchange flows. Up to 30 markets remain scanned. FLOW_CONFIRMED signals require verified current token exchange flows. TECHNICAL_CONTEXT signals may qualify without those flows and explicitly disclose their absence. Both tiers retain all strategy, market, news, calendar, global-supply and cross-venue requirements. Missing flow data never counts as positive evidence, increases the score, or gets labelled verified. Reported flow data that is stale, malformed or adverse blocks qualification; existing flow-confirmed signals cannot silently downgrade into technical entries. The four-per-day cap applies jointly across both tiers and does not promise any daily minimum.

Daily periods must be closed, fresh within 36 hours of period end, and have eight continuous observations. Strong net inflow ratio >20% vetoes longs; net outflow ratio below -20% vetoes shorts. An active-address drop >40% against the previous seven-day mean vetoes either direction when the activity comparison is available. Provider-labelled exchange addresses are incomplete and data may be provisional/revised. These are not live whale observations or proof of selling/buying intent.

DefiLlama global USD stablecoin supply adds broad liquidity context. Weekly contraction greater than 1% vetoes longs. Global supply is not a token exchange-flow measure. Signal receipts preserve context timestamps, flow evidence, relevant headlines and upcoming events inside the compact ledger. Context must be fresh and all mandatory risk checks pass before publication. Daily provider-labelled flows remain incomplete and revisable even in the FLOW_CONFIRMED tier.

## Public price corroboration and indicator receipts

OKX public USDT perpetual tickers are fetched once per minute (at most 1,440 attempted bulk requests/day), directly from Railway and without credentials. Exact token symbols only; multiplier contracts and token aliases are never guessed. Price evidence must be <=90 seconds old and within 0.5% of the Bybit reference, or new publication and entry availability are blocked. Source failures clear availability and do not reuse stale data as current. This is corroboration, not a guarantee of fills or equivalent contract rules. The Binance public API returned a location restriction from this server; no alternate path or bypass is used.

All current closed-candle snapshots expose EMA20/50, Wilder RSI14 and 14-period simple-average true range (ATR) for H1/H4/D1. RSI is supporting context, not a new gate or independent confirmation. Qualified signal receipts include volatility, volume ratio, structural stop, modeled net TP2/SL reward/risk, coverage tier, public-context timestamps and the OKX price observed at publication. Current venue evidence is checked again before entry availability. Prices and tick sizes remain Bybit references; independently check your actual OKX/Binance contract, fees and fills.

No subscriptions, paid APIs or LLM requests are added. No complete worldwide-news, whale-flow, daily-signal or profitable-trading guarantee is made. Push notifications remain unconfigured.

## Storage and deployment

One atomic checkpoint at most every 120 seconds, at most 720 saves/day. The fixed key retains a seven-day signal ledger for up to 30 symbols; candle histories remain in memory and rehydrate after restart. Document cap 1.4 MB and 170 records; typical empty ledger is under 1 KB. Failed recovery never creates a fresh empty ledger. CAS, server throttle, lost-row guards and successful acknowledgement remain mandatory.

The dedicated checkpoint Worker binds to `crypto-engine-manual-checkpoint`, isolated from the full legacy `crypto-shadow-research` database. Its only endpoint is the fixed checkpoint namespace; `ENGINE_TOKEN_HASH` authentication remains required. No generic SQL/table endpoint. The dashboard conservatively estimates 7,920 indexed row writes/day; actual dedicated schema metadata can be lower. Other services still share account quotas; estimates are not account capacity guarantees.

Railway uses one replica, start `node server.mjs`, manual release watch pattern, and `/api/live` liveness. `/api/ready` and `/api/health` distinguish feed/persistence readiness from liveness. Individual required-context failures still block qualification and actionable API/UI state; optional flow coverage is always labelled by tier. Market Worker retains Singapore placement. Keep existing token bindings; do not expose or rotate secrets.

## Research limitations

Exact USDT prices are limit references, not guaranteed fills. Fees 0.055% and slippage 0.015% per side are assumptions. P&L scenarios are separate full-position exits before funding, with no leverage. Win probability and expected profit remain unavailable. Strategies and context veto thresholds are unvalidated; a software release does not supply out-of-sample or forward evidence.

Rollback to a prior Free/manual release only; legacy writers consume excessive resources. Historical rows are preserved. No automatic promotion to live order execution.

## Sources

- https://docs.coinmetrics.io/api/v4/
- https://docs.coinmetrics.io/network-data/network-data-overview/exchange/deposits
- https://docs.coinmetrics.io/network-data/network-data-overview/exchange/withdrawals
- https://www.bls.gov/help/hlpiCAL.htm
- https://www.bea.gov/news/schedule/icalendar
- https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
- https://bybit-exchange.github.io/docs/v5/market/instrument
- https://developers.cloudflare.com/d1/platform/pricing/
