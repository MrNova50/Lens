# Changelog

## 0.3.0

### Minor Changes

- ad9152e: Add a network-aware aggregated `/book/:assetA/:assetB` endpoint with live SDEX levels, synthetic AMM reserve steps, cumulative depth, and source provenance.
- 36eb950: Automatic cataloging of resources from discovery extension upon settlement (#130)
- 81d8e59: Add seller-side Bazaar discovery helpers (`src/bazaar/declare.ts`): `param.*`
  constructors that make per-parameter descriptions a required positional
  argument, `declareHttpResource` / `declareMcpTool` builders that assemble the
  `extensions.bazaar` declaration and its JSON Schema, and
  `validateDeclaration` / `assertDeclaration` which run the catalog's own
  `validateListing` plus seller-side metadata-quality rules so malformed listings
  fail at development time rather than in production. Lens's own gated routes
  (`/price`, `/candles`, `/pools`, `/price/twap`, and the MCP price tool) are
  declared with them in `src/bazaar/lensListings.ts`.
- 059ca5a: Add a `priceUpdated(pair: String!, network: String)` GraphQL subscription that streams live prices over the existing `/graphql` endpoint (graphql-transport-ws protocol). Every ingester (SDEX, Horizon AMM, Soroswap) publishes `{ pair, price, ts, network }` on each new price; subscribers receive only the pair they request. `network` is optional and narrows the stream to one chain — omitting it delivers every enabled network, which is only safe if the subscriber reads the `network` field on each message, since a dual-network deployment otherwise interleaves two chains' prices for the same pair.
- 39f565f: Add `/live` and `/ready`, so a platform can tell "kill this one" apart from
  "stop sending traffic here".

  `/status` answered neither question. It reads `indexer_state`, so it fails when
  Postgres is unreachable — useless as a liveness signal — and it says nothing
  about whether the process has finished booting. `app.listen()` runs part-way
  through `main()`, before the ingesters, the retention worker and the websocket
  fan-out start, so between listening and those loops running the process accepts
  requests it cannot yet answer.

  `GET /live` touches no dependency and stays healthy while Postgres is down or
  the app is still booting. That is the point: a liveness probe that fails during
  a database outage has the orchestrator restarting every instance at once.

  `GET /ready` reports `503` with `ok: false` until `main()` finishes booting, and
  while Postgres is unreachable or unmigrated, or Redis is unreachable when Redis
  is part of readiness (`READINESS_REDIS_CHECK`, default true). The Postgres check
  is one `to_regclass` query answering both reachability and whether migrations
  were applied — reachability alone would report a process with no tables as
  ready. Probes are bounded by `READINESS_TIMEOUT_MS` and answers cached for
  `READINESS_CACHE_MS`, so polling every few seconds costs at most one round trip
  per dependency per interval.

  Both are public, allow-listed from rate limiting next to `/status`, sent
  `Cache-Control: no-store`, and excluded from `http_requests_total` — a
  fixed-interval poller would otherwise put a floor under the request rate that no
  amount of real traffic dropping could go below. `/status` is unchanged.

  The deployed smoke check now requires both probes instead of skipping `/ready`
  when it is absent, and fails on a failing `/live`.

- 3b86612: Add the `lens_get_price` MCP tool, so an agent connected over MCP can ask Lens for
  an aggregated price instead of only searching and paying other people's Bazaar
  nodes. Assets are `CODE` or `CODE:ISSUER`, the issuer binds when both sides name
  one (a same-named asset is refused with `ERR_ASSET_ISSUER_MISMATCH`, never
  priced), the network defaults to the one the server runs, and the answer is
  structured content carrying the price, venues, source count, confidence, the age
  of the last trade and the best route.
- 94bd8ea: Gate `paid_call` behind an operator allow-list of hosts (#404). The tool pays
  whatever URL it is given, up to `MCP_MAX_PAYMENT_PRICE`, from a live key — and
  an agent that reads attacker-influenced text is one sentence from being told
  which URL. `paidCallAllowlist` (server config, `MCP_PAID_CALL_ALLOWED_HOSTS`)
  lists origins or URL prefixes; an unlisted, non-http(s) or credential-bearing
  URL is refused with `ERR_HOST_NOT_ALLOWED` naming the host, before any request
  is sent, and the list cannot be widened by a tool argument. The default is
  empty, which pays nobody.
- 7d187ea: Add `GET /snapshot`: one cached, network-scoped summary of a network's venues
  (liveness), AMM liquidity (TVL, per-asset reserves and per-pool detail), 24h
  traded volume (per venue, with a single-unit total only when the pairs share a
  unit), the busiest pairs with their price direction, stablecoin peg readings,
  and data freshness. All figures come from a single database statement with one
  `as_of` clock, and unknowns are reported as `null` with a reason rather than
  invented. The endpoint is public and never 404s.
- 5ea669e: Bound what a slow websocket client can cost the process.

  `WebSocket#send()` neither blocks nor throws when a peer is slow, it queues.
  Nothing inspected `bufferedAmount`, so one subscriber that stopped reading — a
  suspended mobile client, a wedged TCP window — accumulated price updates in its
  socket buffer without limit, and the message was counted as sent the moment it
  was queued. With the feed pushing continuously, one stuck subscriber was enough
  to grow the process until it was OOM-killed, taking every other subscriber and
  every HTTP client with it.

  `FanOutManager` now applies a per-client policy in
  [`src/ws/backpressure.ts`](https://github.com/Divinity-Labs/Lens/blob/main/src/ws/backpressure.ts):
  past `WS_SLOW_CLIENT_BUFFER_BYTES` (256 KiB) updates are coalesced to the newest
  one, past `WS_MAX_BUFFERED_BYTES` (1 MiB) — or congested for longer than
  `WS_MAX_CONGESTED_MS` (30s) — the client is closed with `1013` and counted in
  `ws_clients_dropped_total`. Superseded updates count in
  `ws_messages_dropped_total`, so a truncated feed is visible rather than silent,
  and `ws_buffered_bytes` reports total queued bytes. All the limits are
  configurable, and none of them can slow down delivery to any other client.

  `ws_messages_sent_total` now increments when the socket reports the write
  completed rather than when `send()` returned, so it counts what was written
  rather than what was queued. The websocket metrics also moved from
  prom-client's global default registry onto the one `/metrics` renders, which is
  where they were supposed to be visible all along.

### Patch Changes

- e091749: Partition the aggregation layer by network. Every function in
  `src/aggregator/vwap.ts` now takes a required `network` and filters
  `price_points`/`pool_snapshots` on it, and `getAMMPrice` filters both the
  `pool_snapshots` scan and the `pool_id` subquery. Previously an unfiltered read
  returned a volume-weighted blend of both chains' rows for a pair key that
  exists on both, so `/price/:a/:b` answered with a number nobody traded at and
  stamped it `"network":"mainnet"`.

  `/price/:assetA/:assetB` passes `req.network` through to the aggregator, so the
  `network` field in the response is the one the numbers came from. The aggregate
  refresh worker now runs once per enabled network — its own queue name, its own
  pair list, and `price_aggregates` upserts stamped with its network — where it
  previously pinned all three to `STELLAR_NETWORK`, leaving the second network's
  `/price/*/history` and `/screener` permanently empty. The Redis price key it
  writes is network-prefixed, matching what the REST route reads.

- 90f3269: `bazaar_search` no longer fetches any URL it is handed (#407). The MCP server now
  parses the target, refuses anything that is not `http`/`https`, resolves the
  hostname and rejects it if any address is private, loopback, link-local, or a
  cloud metadata endpoint (e.g. `169.254.169.254`), and follows redirects manually
  so a permitted host cannot bounce the request to a forbidden address. Operators
  can constrain reachable hosts further with the shared `OUTBOUND_ALLOWED_HOSTS`
  list, which narrows access but never re-opens a blocked address. Blocked requests
  return the new `ERR_URL_BLOCKED` code.
- 7ba1f47: Preserve TWAP timestamp alignment when outlier prices are rejected.
- a6dcd93: `GET /prices/history` accepts `?format=csv`, returning the points as a
  `text/csv` body (`ts,price,volume`, RFC 4180 quoting, LF endings, one trailing
  newline); JSON stays the default and an unknown format is rejected with 400
  before the database is queried. The serializer is `historyToCsv()` in
  `src/api/history.ts`, and `tests/historical.golden.test.ts` byte-compares it —
  plus the HTTP response — against `tests/fixtures/historical-*.csv`, so column
  order, timestamp and number formatting, and line endings cannot drift without
  failing the suite.
- d546b0b: `GET /prices/history` now honours `?network=` / `x-network` instead of always
  querying the deployment's default network, and echoes the resolved `network`
  in the response. `queryHistory()` takes `network` as a parameter.
- 5ef1591: Add a `network` label to the four ingest metrics — `trades_ingested_total`,
  `amm_snapshots_total`, `price_snapshots_total` and `last_trade_timestamp` — so a
  dual-network deployment (`ENABLED_NETWORKS=testnet,mainnet`) reports each
  network separately instead of folding them together.

  `last_trade_timestamp` is the one that mattered: it is a gauge, so the testnet
  ingester's `set()` was overwriting mainnet's value for the same pair every poll
  interval, making Lens's only staleness signal silently unusable — it still
  looked like a plausible timestamp. The counters were less broken but equally
  unqueryable per network, since the two loops summed into one series.

  Cardinality is unchanged in character: `pairs x networks` (plus `pools` on
  `amm_snapshots_total`), all bounded by `WATCHED_PAIRS` and `ENABLED_NETWORKS`.
  No `issuer` or `pool` label was added. Existing queries that did not filter by
  `network` keep working and now return one series per network instead of a
  merged one, so a recording rule that aggregated across networks before will see
  one additional series per pair.

  Documented in [`docs/ingest-metrics.md`](docs/ingest-metrics.md).

- 2337629: The MCP server's spend cap is now cumulative, not just per call. `maxPrice`
  bounded a single payment, so an agent in a retry loop — or one told to "try each
  of these endpoints" — could pay that amount arbitrarily many times: every
  payment individually inside the limit, the sum unbounded. A per-call limit
  answers "how much can one mistake cost"; an operator's question is "how much can
  today cost".

  `SpendBudget` (`src/mcp/budget.ts`) adds a ceiling on the total paid by
  `paid_call` within one UTC day, configured with `MCP_DAILY_SPEND_CEILING`
  (default `$10.00`) alongside the per-call `MCP_MAX_PAYMENT_PRICE`. The day window
  was chosen over a sliding 24 hours because it answers the operator's question
  directly, needs one stored number rather than one entry per payment, and rolls
  over from the wall clock — so a restarted server resumes the same day's total and
  resets it after 00:00 UTC.

  Before a call is made the budget reserves its worst case, the per-call maximum,
  and refuses when that no longer fits what is left. It refuses with the new
  `ERR_BUDGET_EXCEEDED` code carrying the spent, ceiling, remaining and reset time
  in `details.budget`, so an agent can report being out of budget instead of
  looking broken; the refusal happens before the payment fetch, so no money moves.
  Both limits are in the `paid_call` description and the live totals are readable
  without spending, through the new `payment_budget` tool. The running total
  persists to `MCP_SPEND_STATE_FILE` (default `~/.lens-mcp/spend-state.json`) and is
  read back at startup, because a restart does not refund what the previous process
  already spent.

  Accounting is deliberately conservative: the wrapped x402 transport exposes only
  a plain `Response`, so a paid call that could have settled is booked at the
  per-call maximum and a rejection that proves nothing settled is not booked at all.
  Recorded spend is an upper bound, which means the ceiling is reached early rather
  than late — and an unreadable or unwritable state file is treated as fully spent,
  not as a clean slate.

  Also fixed while wiring this up: `MCP_MAX_PAYMENT_PRICE` was passed to
  `wrapFetchWithPaymentFromConfig` as `maxPrice`, which is not an option of the
  x402 client config and was silently ignored — every payment was capped by the
  library default of `$1` whatever the operator asked for. It is now passed as
  `spendControls.maxAmountPerPayment`, so the per-call limit the budget reserves
  against is the one actually enforced.

- 3c43cfe: Fix network-blind webhooks and price tracking across SDEX, Horizon AMM, Soroswap, and Aquarius ingesters:
  - Key module-level `lastPrice` maps by `(network, pairKey)` so price ticks on one chain do not supply the previous price for another chain.
  - Dispatch webhook price updates for the network the event originated from rather than falling back to the process active network.
  - Allow specifying network on webhook subscription (`POST /webhooks`) with validation.
- 2ea353b: Document the full public route surface in `openapi.yaml` (params, the shared
  `?network=` query, and response schemas) and add `tests/openapi.test.ts`, which
  boots the app, enumerates every registered route and fails when a non-internal
  route is missing from the spec. Operator-only and non-HTTP routes are excluded
  through an explicit, commented allow-list in `src/openapi/coverage.ts`. The
  generator is now importable and deterministic, and a test asserts the committed
  `openapi.json` matches it.
- 7ecd06d: `GET /pairs` and `GET /pools` no longer scan the whole history of every network
  on each request. Both now filter by network (`req.network`, default the active
  network) and read one index entry per pair / pool, so cost no longer grows with
  table size. Response shape is unchanged. A pair or pool that has gone quiet is
  still listed with its real last-update timestamp (it is never dropped).
- 2c9d8a4: Snapshot retention now prunes `price_snapshots` for every network in
  `ENABLED_NETWORKS`, not just the active one, so the second network of a
  dual-network process no longer grows unbounded. The startup prune, the BullMQ
  worker and the in-process fallback timer all use the new `pruneAllNetworks()`,
  and the pruned row count is logged per network. `pruneOldSnapshots()` gains an
  optional `network` argument (defaulting to the active network).
- 9abd1f0: `/screener` no longer reports `market_cap`. It was a copy of `liquidity` under another name, so sorting or filtering by market cap silently sorted or filtered liquidity. Lens has no circulating-supply data to compute a real one, so the field is removed from the response and the sort allowlist, and `?market_cap=` and `?sortBy=market_cap` now return a 400 instead of being ignored. The three CTEs behind `/screener` are also now scoped to one network (`?network=` / `x-network`, defaulting to the active network) instead of pooling testnet and mainnet rows.
- d53ac14: Fix `slippagePct` on `/price/:a/:b/route`, which was always exactly 0 because
  the execution price was compared with itself. It is now the shortfall of the
  execution price against the AMM reserve-ratio spot price, so it grows with
  order size against a fixed pool. Route selection and `estimatedOutput` are
  unchanged. Slippage is only reported for an AMM route; SDEX and SPLIT routes
  (and pairs with no AMM pool) have no size-independent spot reference, so the
  value stays 0 rather than reporting a cross-venue spread as slippage.
- 61c1854: Fix `GET /status`: scope `indexer_state` to the requested network (`?network=`
  / `x-network`, defaulting to `STELLAR_NETWORK`) instead of returning whichever
  chain wrote most recently, and report the answering network and its watched
  pairs in the response.

  The SDEX and AMM ingesters now derive each trade's ledger from the TOID prefix
  of its Horizon id — Horizon sends no `ledger` field on a trade — so price points
  carry a real ledger again and `lastIndexedLedger` is no longer permanently null.
  A malformed id falls back to the last stored ledger, and the batch is deferred
  if no ledger can be established. A new `ingestLagSeconds` field surfaces a
  stalled ingester without Prometheus.

- 3cdb4bd: Route all logging through pino (`src/logger.ts`) instead of `console.*`. Every
  module now logs through a component-scoped child logger — `ingester:sdex`,
  `job:aggregate-refresh`, `ws:fanout`, `redis`, `config`, `webhook`,
  `route:price`, … — emitted as a structured `component` field rather than a
  message prefix, so operators can filter by component without regexing text.
  Fastify's request logger is built from the same options, so `req.log` carries
  the same redaction and formatting.

  The level is configurable via `LOG_LEVEL` (default `info`, documented in
  `.env.example`): logs are newline-delimited JSON when `NODE_ENV=production` and
  pretty-printed for humans otherwise. Values of secret-looking environment
  variables (`DATABASE_URL`, `DIRECT_DATABASE_URL`, `REDIS_URL`, and any name
  containing `KEY`/`SECRET`/`TOKEN`/`PASSWORD`) are scrubbed from every
  serialized line, including the password inside a connection string and driver
  error messages that echo it, while request auth headers are redacted via
  pino's `redact`. A test asserts no `console.*` survives in non-test source and
  that a connection string or API key value never reaches the output.

- 29e834a: Config now validates every Soroban contract id it hands out (Soroswap factory,
  Reflector oracle) with `StrKey.isValidContract`. A malformed id no longer boots
  the feature "enabled" and fails on every RPC call: it logs a warning naming the
  env var and disables that feature on that network. Two built-in defaults were
  55 characters and therefore invalid; the testnet Soroswap factory default is
  replaced with the address from Soroswap's published testnet deployment, and the
  mainnet Reflector default is removed, so the oracle stays off until
  `REFLECTOR_CONTRACT_ID_MAINNET` is set. `.env.example` and the deploy docs are
  updated.
- 789b054: `GET /volumes/:asset` now filters `price_points` by network instead of summing
  testnet and mainnet volume together. It accepts `?network=testnet|mainnet`
  (default: the active network), returns 400 for any other value, and echoes the
  resolved `network` in the response body.
- dca5ff3: Add `docs/x402-conformance.md`: a conformance baseline for the public `x402.org`
  facilitator on `stellar:testnet`, established by settling a real payment through
  it with an unmodified `@stellar/stellar-sdk` client and feeding it deliberately
  bad input. Records `/supported` verbatim, a settled transaction hash, a
  reason-per-rejection table, and five divergences between the reference
  implementation's advertised and actual behaviour. This is the baseline the Lens
  facilitator (#124, #125, #126) is measured against.
- 94bd8ea: Add an end-to-end test for the successful x402 402 payment loop (#423). Drives the real
  `@x402/fetch` transport against a stubbed resource + fake facilitator, signing a real Soroban
  `transfer` with `@stellar/stellar-sdk` using throwaway testnet keys. Asserts on what was signed —
  amount, destination and network passphrase (valid on testnet, invalid on mainnet) — not just the
  response body, and covers the failure branches: amount above maxPrice refused before submitting,
  a network the client is not registered for, and an expired signature that the facilitator rejects.

## 0.2.0

### Minor Changes

- bbe48e4: Add `/prices/history` endpoint backed by 1-minute price snapshots. A new `price_snapshots` table is appended to every minute by a snapshot ingester, queryable over a `[from, to]` window with optional `5m`/`1h` aggregation. A retention job prunes snapshots older than 30 days.

### Patch Changes

- 5a68745: Adopt changesets for versioning and release notes. Adds `@changesets/cli`, a release GitHub Actions workflow that opens a "Version Packages" PR for pending changesets and tags releases on merge, and contributor docs for the workflow.

All notable changes to Lens are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- CI pipeline (`.github/workflows/ci.yml`) running Prisma generate, typecheck, and build on every PR
- Contributor documentation, issue templates, PR template
- This changelog

## [0.1.0] — 2025 initial deployment

### Added

- Fastify REST API with `GET /price/:assetA/:assetB`, `GET /status`, `GET /pools`
- GraphQL endpoint via Mercurius
- SDEX trade ingestion with checkpoint tracking
- AMM pool snapshot ingestion
- Best-route price calculation across SDEX and AMM
- x402 micropayment gating via `@x402/stellar`
- Prisma schema for price points, pools, and checkpoints
- BullMQ aggregate refresh worker (optional, requires Redis)
- Supabase Postgres support with scoped SSL handling
- Deployed on Render at https://lens-ldtu.onrender.com

### Fixed

- `bestRoute.ts` AMM lookup — was using broken `code:code` join format; now queries via `pool_id`
- Prisma binary target on Render (`debian-openssl-3.0.x`)
- Supabase SSL cert error (scoped to supabase.com hosts)
- BullMQ blocking startup — wrapped in try/catch, ingesters auto-restart

[Unreleased]: https://github.com/Miracle656/Lens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Miracle656/Lens/releases/tag/v0.1.0
