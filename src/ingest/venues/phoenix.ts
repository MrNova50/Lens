/**
 * Phoenix AMM Venue Adapter (Stellar Soroban)
 *
 * Phoenix is a Soroban xy=k DEX with live pools and real volume, and Lens priced
 * none of it: a caller asking for the best price on a pair Phoenix quoted got an
 * answer that silently ignored the venue. This adapter reads each pool's reserves
 * over Soroban RPC, derives the spot price from the constant-product invariant,
 * and stores it in `price_points` with `source = 'phoenix_amm'` — its own series,
 * never blended into another venue's, so a dead market can never be averaged with
 * a live one.
 *
 * Pools are discovered, not hard-coded: the list comes from the Phoenix factory's
 * own `query_all_pools_details`, cached per network behind a TTL (pool sets change
 * when someone creates or deregisters a pool, not every tick, while reserves
 * change on every swap — so discovery is cached and reserves are always re-read).
 *
 * The factory contract ids are Phoenix's documented deployments, written in full:
 *   mainnet  CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI
 *   testnet  CBIFTP5CLUIVIVJ7WAMGOQPYPCV3CH3AVMHNWIL5XDPYCRWLBPUWL7FI
 *
 * Phoenix pools trade Soroban SAC token contracts, while a watched pair names its
 * assets the classic way (`CODE:ISSUER`), so the two are joined by
 * `PHOENIX_TOKEN_ADDRESSES[_NETWORK]`. The built-in map holds only addresses this
 * repo already carries: native XLM's Stellar Asset Contract wrapper (derived from
 * the network id and therefore identical on both networks) and mainnet Circle
 * USDC. No testnet contract id is invented — until an operator names one, a
 * testnet pool simply has no known price rather than a guessed one.
 *
 * Failure mode is "no Phoenix price", never "no Lens": an unreachable RPC yields
 * an empty discovery or a null read rather than a throw, an empty pool yields no
 * price rather than a divide-by-zero, and every other venue keeps ingesting.
 *
 * Issue: #210
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  scValToNative,
  xdr,
  rpc as SorobanRpc,
} from '@stellar/stellar-sdk'
import {
  activeNetwork,
  getNetworkConfig,
  type NetworkName,
  type PhoenixTokenAddress,
} from '../../config'
import { getRpcServer } from '../../network/clients'
import type { AssetId, WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  getLastPrice,
  resetLastPrice,
  writeVenuePricePoints,
  startVenueAdapter,
} from './runner'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Rows written by this venue. Distinct from every other venue, on purpose. */
export const PHOENIX_SOURCE = 'phoenix_amm'

/**
 * The shared Stellar Asset Contract wrapper for the native asset. It is derived
 * from the network id plus the "lmex" mnemonic, so the same contract id names
 * native XLM on testnet and on mainnet — see the doc page
 * "How SAC works" on developers.stellar.org.
 */
export const XLM_SAC_CONTRACT_ID = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'

// Ephemeral fee-payer account: simulation never charges it.
const FEE_PAYER_KEYPAIR = Keypair.random()

/** Factory view that returns every registered pool with its current balances. */
const QUERY_ALL_POOLS_DETAILS_FN = 'query_all_pools_details'
/** Pool view returning `asset_a` / `asset_b` (address + amount) plus the LP share. */
const QUERY_POOL_INFO_FN = 'query_pool_info'

export function _resetLastPrice(): void {
  resetLastPrice('Phoenix')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('Phoenix', network, pairKey)
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** One Phoenix xy=k pool, as the factory reports it. */
export interface PhoenixPool {
  poolAddress: string
  /** Token contract on the pool's `asset_a` side. */
  tokenA: string
  /** Token contract on the pool's `asset_b` side. */
  tokenB: string
  /** `asset_a` balance held by the pool, in the token's smallest units. */
  reserveA: bigint
  /** `asset_b` balance held by the pool, in the token's smallest units. */
  reserveB: bigint
  /** Swap fee in basis points, reported by the factory. Kept for provenance. */
  totalFeeBps: number | null
}

/** A reserve snapshot for one discovered pool, in the pool's own A/B order. */
export interface PhoenixPoolReserves {
  pool: PhoenixPool
  reserveA: bigint
  reserveB: bigint
}

// ── Low-level Soroban RPC ─────────────────────────────────────────────────────

function passphraseFor(network: NetworkName): string {
  return getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC
}

/**
 * Simulate a read-only contract call and return its ScVal, or null when the id is
 * not a contract, the RPC is unreachable, the simulation errors, or the contract
 * returns nothing. Never throws: an unreachable Phoenix RPC must degrade this
 * venue only, not the process.
 */
export async function simulateRead(
  contractId: string,
  fnName: string,
  network: NetworkName = activeNetwork,
  args: xdr.ScVal[] = []
): Promise<xdr.ScVal | null> {
  try {
    if (!StrKey.isValidContract(contractId)) {
      console.debug(`[phoenix] Refusing to call non-contract id ${contractId}`)
      return null
    }

    const rpc = getRpcServer(network)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: passphraseFor(network),
    })
      .addOperation(new Contract(contractId).call(fnName, ...args))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationError(sim)) {
      console.debug(`[phoenix] ${fnName} simulation error on ${contractId}:`, sim.error)
      return null
    }
    return sim.result?.retval ?? null
  } catch (err) {
    console.debug(`[phoenix] ${fnName} failed on ${contractId}:`, (err as Error).message)
    return null
  }
}

// ── Decoding ──────────────────────────────────────────────────────────────────

function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  return null
}

/** A `{ address, amount }` asset entry, as returned by the factory and the pool. */
function readAsset(value: unknown): { address: string; amount: bigint } | null {
  if (!value || typeof value !== 'object') return null
  const { address, amount } = value as Record<string, unknown>
  if (typeof address !== 'string' || !StrKey.isValidContract(address)) return null
  const parsed = toBigInt(amount)
  if (parsed === null) return null
  return { address, amount: parsed }
}

/**
 * Pure: decode the factory's `query_all_pools_details` retval (a `Vec` of
 * `LiquidityPoolInfo { pool_address, pool_response, total_fee_bps }`).
 *
 * Anything that does not decode cleanly is dropped rather than guessed for: a
 * pool whose address or balances cannot be read is a pool this venue does not
 * quote, exactly as if the factory had not listed it.
 */
export function decodePhoenixPools(retval: unknown): PhoenixPool[] {
  let decoded: unknown
  try {
    decoded = scValToNative(retval as xdr.ScVal)
  } catch (err) {
    console.debug('[phoenix] Failed to decode pool list:', (err as Error).message)
    return []
  }
  if (!Array.isArray(decoded)) return []

  const pools: PhoenixPool[] = []
  for (const entry of decoded) {
    if (!entry || typeof entry !== 'object') continue
    const { pool_address: poolAddress, pool_response: poolResponse, total_fee_bps: feeBps } =
      entry as Record<string, unknown>
    if (typeof poolAddress !== 'string' || !StrKey.isValidContract(poolAddress)) continue

    const response = (poolResponse && typeof poolResponse === 'object' ? poolResponse : entry) as Record<string, unknown>
    const assetA = readAsset(response.asset_a)
    const assetB = readAsset(response.asset_b)
    if (!assetA || !assetB) continue

    pools.push({
      poolAddress,
      tokenA: assetA.address,
      tokenB: assetB.address,
      reserveA: assetA.amount,
      reserveB: assetB.amount,
      totalFeeBps: typeof feeBps === 'number' || typeof feeBps === 'bigint' ? Number(feeBps) : null,
    })
  }
  return pools
}

/** Pure: decode one pool's `query_pool_info` retval into a reserve snapshot. */
export function decodePoolReserves(retval: unknown, pool: PhoenixPool): PhoenixPoolReserves | null {
  let decoded: unknown
  try {
    decoded = scValToNative(retval as xdr.ScVal)
  } catch (err) {
    console.debug(`[phoenix] Failed to decode pool info for ${pool.poolAddress}:`, (err as Error).message)
    return null
  }
  if (!decoded || typeof decoded !== 'object') return null

  const assetA = readAsset((decoded as Record<string, unknown>).asset_a)
  const assetB = readAsset((decoded as Record<string, unknown>).asset_b)
  if (!assetA || !assetB) return null

  return { pool, reserveA: assetA.amount, reserveB: assetB.amount }
}

// ── Watched-pair ↔ token-contract resolution ─────────────────────────────────

/**
 * Pure: the Soroban token contract a watched asset trades as on Phoenix.
 *
 * Lookup is by `CODE:ISSUER` first and `CODE` second (codes are compared
 * case-insensitively, issuers exactly), so an operator can disambiguate the many
 * unrelated assets that share a code. Returns null when the asset is not mapped —
 * an unmapped asset simply quotes no pool instead of quoting the wrong token.
 */
export function resolveTokenAddress(
  asset: AssetId,
  network: NetworkName = activeNetwork,
  map: PhoenixTokenAddress[] = getNetworkConfig(network).phoenix.tokenAddresses
): PhoenixTokenAddress | null {
  const keyed = asset.issuer ? `${asset.code}:${asset.issuer}` : asset.code
  const list = map ?? []
  const isValid = (entry: PhoenixTokenAddress) => StrKey.isValidContract(entry.tokenAddress)

  // Exact `CODE:ISSUER` (or bare `CODE` for the native asset) first: precise, and
  // how an operator disambiguates the many unrelated assets that share a code.
  const exact = list.find(
    (entry) => entry.key.toUpperCase() === keyed.toUpperCase() && isValid(entry)
  )
  if (exact) return exact

  // Fall back to a bare-code mapping only for a credited asset, and only against
  // an entry that itself carries no issuer — so a `USDC` key can never shadow a
  // differently-issued asset that happens to share the code.
  if (asset.issuer) {
    const byCode = list.find(
      (entry) =>
        !entry.key.includes(':') &&
        entry.key.toUpperCase() === asset.code.toUpperCase() &&
        isValid(entry)
    )
    if (byCode) return byCode
  }
  return null
}

/**
 * Pure: does this pool quote the pair, in either orientation?
 *
 * Returns the pair's asset mapped onto the pool's A/B order: `'direct'` when the
 * pair's assetA is the pool's tokenA, `'swapped'` when it is the pool's tokenB,
 * and null when the pool is not this pair. Orientation matters because the price
 * written for a pair always means "units of assetB per unit of assetA" — quoting
 * it backwards is precisely the silent-corruption failure this repo guards
 * against, and a pool has no way to tell which side a caller asked for.
 */
export function matchPoolToPair(
  pool: Pick<PhoenixPool, 'tokenA' | 'tokenB'>,
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  map?: PhoenixTokenAddress[]
): 'direct' | 'swapped' | null {
  const tokenA = resolveTokenAddress(pair.assetA, network, map)
  const tokenB = resolveTokenAddress(pair.assetB, network, map)
  if (!tokenA || !tokenB) return null

  const direct =
    tokenA.tokenAddress === pool.tokenA && tokenB.tokenAddress === pool.tokenB
  const swapped =
    tokenA.tokenAddress === pool.tokenB && tokenB.tokenAddress === pool.tokenA
  if (direct) return 'direct'
  if (swapped) return 'swapped'
  return null
}

// ── Spot price ────────────────────────────────────────────────────────────────

/**
 * Pure: constant-product spot price as the ratio of two raw i128 reserves,
 * `reserveX / reserveY` — how much of Y one unit of X is worth.
 *
 * Both sides are in their token's smallest units; every Stellar SAC asset is
 * 7-decimal like classic assets, so the ratio is already the tradable price and
 * needs no scaling (a venue whose tokens differed in scale would be mis-scaled by
 * every venue adapter in this repo, not just this one).
 *
 * A pool with either side at zero (or negative, which a corrupt read can produce)
 * has no defined price, so 0 is returned *before* any division — never Infinity,
 * never NaN, and never a number another venue could average in.
 */
export function calcSpotPrice(reserveX: bigint, reserveY: bigint): number {
  if (reserveX <= 0n || reserveY <= 0n) return 0
  const price = Number(reserveX) / Number(reserveY)
  return Number.isFinite(price) && price > 0 ? price : 0
}

// ── Discovery, with a per-network TTL cache ───────────────────────────────────

interface DiscoveryCacheEntry {
  fetchedAt: number
  pools: PhoenixPool[]
}

/**
 * Cached per network, never shared: mainnet and testnet pool sets are different
 * markets, and one cache keyed by pair alone would serve one network the other's
 * pools.
 */
const discoveryCache = new Map<NetworkName, DiscoveryCacheEntry>()

/** Test/shutdown hook: drops cached pool lists so the next cycle re-discovers. */
export function resetPhoenixPoolCache(): void {
  discoveryCache.clear()
}

/** Number of live cache entries — exposed for tests. */
export function phoenixPoolCacheSize(): number {
  return discoveryCache.size
}

/**
 * Read the full pool set straight from the Phoenix factory. Returns [] when the
 * factory is unconfigured or unreachable, so the caller treats "no pools" exactly
 * like "no price from this venue".
 */
export async function fetchPhoenixPoolsFromFactory(
  factoryAddress: string,
  network: NetworkName = activeNetwork
): Promise<PhoenixPool[]> {
  const retval = await simulateRead(factoryAddress, QUERY_ALL_POOLS_DETAILS_FN, network)
  if (!retval) return []
  return decodePhoenixPools(retval)
}

export interface PhoenixPoolFetcher {
  (factoryAddress: string, network: NetworkName): Promise<PhoenixPool[]>
}

/**
 * Discovery with a TTL. Pools are created and deregistered far less often than
 * they are traded, so the list is cached per network and only refetched once the
 * entry has aged out — never once per watched pair per request.
 *
 * A refetch that fails (empty result from an unreachable factory) keeps serving
 * the previous list until it is truly stale rather than dropping the venue for a
 * blip; a genuinely empty factory simply has no pools to price.
 */
export async function getPhoenixPools(
  network: NetworkName = activeNetwork,
  fetchPools: PhoenixPoolFetcher = fetchPhoenixPoolsFromFactory
): Promise<PhoenixPool[]> {
  const phoenix = getNetworkConfig(network).phoenix
  if (!phoenix.enabled || !phoenix.factoryAddress) return []

  const now = Date.now()
  const cached = discoveryCache.get(network)
  if (cached && now - cached.fetchedAt < phoenix.discoveryTtlMs) return cached.pools

  let pools: PhoenixPool[] = []
  try {
    pools = await fetchPools(phoenix.factoryAddress, network)
  } catch (err) {
    // Fetchers are written not to throw; this keeps a throwing one from
    // escalating into the runner either.
    console.error(`[phoenix] Pool discovery failed on ${network}:`, (err as Error).message)
    return cached?.pools ?? []
  }

  if (pools.length === 0 && cached) {
    console.debug(
      `[phoenix] Discovery on ${network} returned no pools; keeping ${cached.pools.length} cached pool(s)`
    )
    return cached.pools
  }

  discoveryCache.set(network, { fetchedAt: now, pools })
  return pools
}

// ── Reserve reading ───────────────────────────────────────────────────────────

/**
 * Read a pool's current reserves. Cached discovery data is only a pool *list*:
 * reserves come from the chain on every cycle, so a stale balance is never
 * written as a price. Returns null when the pool cannot be read.
 */
export async function fetchPoolReserves(
  pool: PhoenixPool,
  network: NetworkName = activeNetwork
): Promise<PhoenixPoolReserves | null> {
  const retval = await simulateRead(pool.poolAddress, QUERY_POOL_INFO_FN, network)
  if (!retval) return null
  return decodePoolReserves(retval, pool)
}

// ── Derivation ────────────────────────────────────────────────────────────────

/**
 * Pure: derive price points for `pair` from reserve snapshots. A pool that does
 * not quote the pair, or that has no quotable price, contributes nothing.
 */
export function derivePhoenixPricePoints(
  readings: (PhoenixPoolReserves | null)[],
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  map?: PhoenixTokenAddress[]
): VenuePricePoint[] {
  const points: VenuePricePoint[] = []

  for (const reading of readings) {
    if (!reading) continue
    const orientation = matchPoolToPair(reading.pool, pair, network, map)
    if (!orientation) continue

    // The pool reports reserves in its own A/B order; orient them to the watched
    // pair so the price is written for the correct pair direction.
    const [reserveOfA, reserveOfB] =
      orientation === 'direct'
        ? [reading.reserveA, reading.reserveB]
        : [reading.reserveB, reading.reserveA]

    // Matches the repo's constant-product convention (Soroswap/Aquarius):
    // price = reserveOfA / reserveOfB, i.e. assetA's reserve over assetB's.
    const spotPrice = calcSpotPrice(reserveOfA, reserveOfB)
    if (spotPrice === 0) {
      console.debug(`[phoenix] Pool ${reading.pool.poolAddress} has no quotable price — skipping`)
      continue
    }

    points.push({
      assetA: pair.assetA.code,
      assetB: pair.assetB.code,
      pairKey: pair.pairKey,
      source: PHOENIX_SOURCE,
      poolId: reading.pool.poolAddress,
      price: spotPrice,
      baseVolume: 0,
      counterVolume: 0,
      ledger: 0,
      timestamp: new Date(),
      eventId: `phoenix-${reading.pool.poolAddress}-${Date.now()}`,
    })
  }

  return points
}

// ── Per-pair ingestion ────────────────────────────────────────────────────────

export interface PhoenixIngestDeps {
  getPhoenixPools: (network: NetworkName) => Promise<PhoenixPool[]>
  fetchPoolReserves: (pool: PhoenixPool, network: NetworkName) => Promise<PhoenixPoolReserves | null>
}

const defaultDeps: PhoenixIngestDeps = { getPhoenixPools, fetchPoolReserves }

/**
 * Discover, read, derive and write every Phoenix pool that quotes `pair`.
 *
 * An unreadable pool is skipped and the cycle continues, so a Phoenix RPC outage
 * looks exactly like "no Phoenix price today" — the venue degrades, the process
 * does not.
 */
export async function ingestPhoenixPair(
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  deps: PhoenixIngestDeps = defaultDeps,
  writePoints: (
    points: VenuePricePoint[],
    pair: WatchedPair,
    network: NetworkName
  ) => Promise<void> = async (points, p, n) => {
    await writeVenuePricePoints('Phoenix', points, p, n)
  }
): Promise<void> {
  try {
    const pools = await deps.getPhoenixPools(network)
    if (pools.length === 0) {
      console.debug(`[phoenix] No pools discovered on ${network} — skipping ${pair.pairKey}`)
      return
    }

    const candidates = pools.filter((pool) => matchPoolToPair(pool, pair, network) !== null)
    if (candidates.length === 0) {
      console.debug(`[phoenix] No pool quotes ${pair.pairKey} on ${network} — skipping`)
      return
    }

    const readings = await Promise.all(
      candidates.map((pool) => deps.fetchPoolReserves(pool, network))
    )

    const points = derivePhoenixPricePoints(readings, pair, network)
    if (points.length === 0) return

    await writePoints(points, pair, network)
  } catch (err) {
    // Belt-and-braces: nothing in this venue may reject into the runner.
    console.error(
      `[phoenix] Ingest cycle for ${pair.pairKey} on ${network} failed:`,
      (err as Error).message
    )
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const phoenixAdapter: VenueAdapter<PhoenixPool, PhoenixPoolReserves> = {
  name: 'Phoenix',
  source: PHOENIX_SOURCE,

  isEnabled(network: NetworkName): boolean {
    return getNetworkConfig(network).phoenix.enabled
  },

  getPollIntervalMs(network: NetworkName): number {
    return getNetworkConfig(network).phoenix.pollIntervalMs
  },

  async discover(pair: WatchedPair, network: NetworkName): Promise<PhoenixPool[]> {
    const pools = await getPhoenixPools(network)
    return pools.filter((pool) => matchPoolToPair(pool, pair, network) !== null)
  },

  async read(target: PhoenixPool, _pair: WatchedPair, network: NetworkName): Promise<PhoenixPoolReserves | null> {
    return fetchPoolReserves(target, network)
  },

  derive(
    raw: PhoenixPoolReserves | null,
    target: PhoenixPool,
    pair: WatchedPair,
    network: NetworkName
  ): VenuePricePoint[] {
    if (!raw) return []
    return derivePhoenixPricePoints([{ ...raw, pool: target }], pair, network)
  },

  async write(points: VenuePricePoint[], _target: PhoenixPool, pair: WatchedPair, network: NetworkName): Promise<void> {
    await writeVenuePricePoints('Phoenix', points, pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName): Promise<void> {
    await ingestPhoenixPair(pair, network)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startPhoenixIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(phoenixAdapter, network)
}
