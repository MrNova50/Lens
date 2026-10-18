---
'lens': minor
---

`src/ingest/cex/` ships its first real adapter (#215): `CoinbaseCexAdapter`
implements `CexAdapter` end to end against Coinbase Exchange's public
market-data endpoints — ticker and level-1 book — with no API key. Pair
identifiers normalise in both directions between Lens's canonical `XLM/USDC`
and Coinbase's `XLM-USDC`; adapters are built and registered through the new
`createCexAdapter()` factory, and an unknown exchange name logs a warning and
returns undefined rather than throwing.

The adapter rate-limits itself to Coinbase's published public limit (10
requests per second per IP, bursts of 15) with a token bucket, honors
`Retry-After` on HTTP 429 with an exponential fallback, and degrades any
exchange outage — network error, 429 storm, malformed body — to a null ticker
instead of an exception. Every ticker carries `source = 'coinbase'` so a CEX
number can never be blended into an on-chain series, and the estimated
`quoteVolume` (Coinbase publishes only base-asset volume) is flagged with
`quoteVolumeEstimated`. `src/__tests__/cexCoinbase.test.ts` covers both
normalisation directions, the bucket's pacing, a stubbed 429 with and without
`Retry-After`, and the never-throw degradation contract.
