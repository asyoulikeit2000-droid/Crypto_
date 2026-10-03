# Strategy selection — 5,000 USDT initial capital

Date: 2026-10-03

## Objective

Build toward 50,000 USDT as a milestone using compounding, without allowing the calendar target to increase risk after losses.

The target is a research/business objective, not a guaranteed return and not an input to leverage escalation.

## Current fee assumptions

Research uses conservative retail derivatives execution assumptions. For the first sanity test, total round-trip friction was modeled at approximately 9 bps: maker-style entry fee + taker-style protective exit fee + a small slippage reserve. Exact live economics must use the account's actual exchange fee tier and actual fills.

## Fresh market observations

Recent Binance USD-M samples showed that typical 5-minute absolute moves in BTC/ETH are often too close to retail execution costs to justify an ultra-short scalping design. 15-minute ranges provide more room, especially in SOL/XRP, while remaining short enough for multiple daily opportunities.

Therefore V1 is designed for approximately 15–90 minute holding periods rather than millisecond/one-minute HFT.

## 90-day OHLC sanity test

Universe: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT
Period: 2026-07-05 through 2026-10-03
Bars: 30-minute
Cost model: 9 bps round trip
Execution: conservative same-bar stop-first assumption when both stop and target are touched

These were deliberately simple benchmark rules, not production strategies.

| Market | Pullback avg net bps | Breakout avg net bps | Naive mean reversion avg net bps |
| --- | ---: | ---: | ---: |
| BTCUSDT | -10.91 | -5.42 | +8.88 |
| ETHUSDT | -11.46 | -9.10 | -27.66 |
| SOLUSDT | -7.14 | -0.94 | +8.01 |
| XRPUSDT | -9.02 | -8.46 | +6.39 |

Interpretation:
- Generic trend pullbacks are rejected.
- Generic breakouts are rejected as the primary strategy; SOL was closest to breakeven but is not enough evidence.
- Naive mean reversion is too sparse and inconsistent, especially on ETH.
- A production candidate must add microstructure confirmation rather than rely on candles alone.

## Selected V1 research family

**Microstructure-confirmed liquidity-sweep reversion**

Concept:
1. A meaningful 5–15 minute impulse sweeps liquidity.
2. Longer-window signed flow was aligned with the impulse.
3. Very recent aggressive flow turns against that impulse.
4. The order book also recovers in the reversal direction.
5. The one-minute return stabilizes.
6. The system refuses to fade a strong directional trend or abnormal/high-volatility regime.
7. Spread and data freshness must pass.
8. Entry remains research/shadow-only until historical calibration produces a positive after-cost expectancy.

This is not classic RSI mean reversion. The hypothesis is that price temporarily overshoots when aggressive flow exhausts, then reverts once order-book and trade-flow evidence confirms absorption.

## Capital/risk design for 5,000 USDT

Initial production candidate defaults:
- Base planned risk per high-quality trade: 0.20% of equity = 10 USDT at 5,000.
- Absolute hard single-trade ceiling remains 0.25% unless explicitly changed after validation.
- Position notional is derived from stop distance, not chosen from leverage.
- Example: 10 USDT risk / 0.25% stop = 4,000 USDT notional.
- Maximum initial notional cap: 5,000 USDT per position.
- Maximum open positions default: 2.
- At 2% account drawdown, risk multiplier falls to 75%.
- At 3.5% drawdown, risk multiplier falls to 50%.
- At 5% drawdown, no new positions may be sized.
- Execution edge gate: the larger of 6.50 USDT modeled net expectancy or 0.10% of current account equity.

The equity-based gate means required edge scales with the account instead of staying fixed at 5 USDT forever.

## Next validation work

Before live execution:
- collect longer same-venue Binance tick/order-book/trade history
- label liquidity-sweep candidates and outcomes
- calibrate expected gross move by score/regime/symbol
- subtract actual fee, spread, slippage and funding assumptions
- walk-forward test by time
- reject symbols/regimes with unstable expectancy
- shadow execute on live Binance market data
- compare modeled vs observed maker fill rate and slippage
- demo execution
- tiny real-capital validation

No strategy is allowed to become live merely because the account target is behind schedule.
