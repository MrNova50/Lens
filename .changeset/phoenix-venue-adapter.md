---
"lens": minor
---

Add a Phoenix AMM venue adapter (`src/ingest/venues/phoenix.ts`, issue #210). Phoenix is a Soroban xy=k DEX with live pools and real volume that Lens priced none of: a caller asking for the best price on a pair Phoenix quoted got an answer that silently ignored the venue.

- Pools are **discovered, not hard-coded**: the set comes from the Phoenix factory's `query_all_pools_details`, cached per network behind a TTL (`PHOENIX_DISCOVERY_TTL_MS`, default 5 min) so discovery is not repeated per watched pair per request, while reserves are re-read every poll.
- Each row is written to `price_points` with `source = 'phoenix_amm'` and carries the `network` it was read from — a distinct series, never blended into another venue's price.
- The adapter is registered in the venue-adapter registry, so one Phoenix instance starts per entry in `ENABLED_NETWORKS`, each writing its own network.
- Factory contract ids are Phoenix's documented deployments, written in full (mainnet `CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI`, testnet `CBIFTP5CLUIVIVJ7WAMGOQPYPCV3CH3AVMHNWIL5XDPYCRWLBPUWL7FI`). Watched pairs name assets the classic `CODE:ISSUER` way, so they are joined to Phoenix's SAC token contracts via `PHOENIX_TOKEN_ADDRESSES[_NETWORK]`; only verifiable ids (native XLM's deterministic SAC wrapper, mainnet Circle USDC) are built in, and no testnet id is invented.
- Fault isolation: an unreachable Phoenix RPC yields an empty discovery or a null read rather than a throw, a zero-reserve pool yields no price rather than a divide-by-zero, and every other venue keeps ingesting.

Configure with `PHOENIX_FACTORY_ADDRESS[_NETWORK]`, `PHOENIX_ENABLED[_NETWORK]`, `PHOENIX_TOKEN_ADDRESSES[_NETWORK]`, `PHOENIX_POLL_INTERVAL_MS[_NETWORK]` and `PHOENIX_DISCOVERY_TTL_MS[_NETWORK]` (documented in `.env.example`).
