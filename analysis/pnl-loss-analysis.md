# P&L Simulation Loss Analysis

Date: 2026-09-03

## Incident

The dashboard showed `-$1,086` with `$1,000` starting capital over a 7-day window.
That result was impossible under the intended no-leverage model because the simulator could lose more than the available account balance.

## Root cause

`calculatePnl()` passed the full starting capital to every detected opportunity and then added every result together. In effect, the same `$1,000` was reused for all 60 attempts without reducing the balance after a losing attempt. The result modeled repeated borrowing, not a sequential portfolio.

## Corrective model

- Process detections in chronological order.
- Use the current available balance as the maximum capital for the next attempt.
- Keep the existing liquidity limit and per-position cap.
- Subtract the expected result from available capital after every funded attempt.
- Stop funding attempts when the balance reaches zero.
- Clamp the ending balance at zero, so `P&L >= -starting capital`.
- Report funded attempts separately from skipped attempts.
- Model two paths for every attempt:
  - Gap holds: gross spread minus trading fees, slippage, bridge fees, and gas.
  - Gap reverts: no gross spread; only modeled execution costs are lost.
- Use a persistence-weighted expected result instead of presenting the best case as realized profit.

## Regression guardrails

For every period and starting balance:

1. Ending balance must never be negative.
2. P&L must never be lower than negative starting capital.
3. A losing trade must reduce the capital available to the next trade.
4. Once capital is exhausted, later detections must be marked skipped rather than funded.
5. Reversion losses must be displayed as negative values.
6. The dashboard must label the result as simulated/expected; it must not be presented as realized on-chain P&L.

## Data limitation

The monitor has read-only market data and does not sign or submit transactions. A gap persistence probability is therefore a model based on observed repeat detections, chain/token verification, gap size, and incident signals. It is not proof that a trade would have filled. The period result is limited to detection history retained by the running monitor process.
