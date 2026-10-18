/**
 * Unit tests for the Phoenix AMM venue adapter (#210).
 *
 * Covers the acceptance criteria:
 * - reserve → spot-price derivation, including a pool with zero reserves
 * - pools discovered from the factory and cached behind a TTL (not per request)
 * - the network read from is the network written (one instance per ENABLED_NETWORKS)
 * - an unreachable Phoenix RPC degrades this venue, never the process
 *
 * `scValToNative` is stubbed to identity so the decode path can be driven with the
 * plain JS shape the SDK would hand back, while real StrKey validation still runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const POOL1 = 'CAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSBFLM'
const POOL2 = 'CBSWMZ3INFVGW3DNNZXXA4LSON2HK5TXPB4XU634PV7H7AEBQKBYINJH'
const XLM_SAC = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const FACTORY_MAINNET = 'CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  upsertPricePoints: vi.fn().mockResolvedValue(undefined),
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
  publishPriceUpdate: vi.fn(),
  getActivePairs: vi.fn().mockReturnValue([]),
}))

// Mutable per-test knobs for the mocked network config, so a test can drive the
// disabled / unconfigured branches without re-mocking the whole config module.
const configState = vi.hoisted(() => ({ enabled: true, blankFactory: false }))

vi.mock('../db', () => ({ upsertPricePoints: mocks.upsertPricePoints }))
vi.mock('../webhookDispatcher', () => ({ dispatchPriceUpdate: mocks.dispatchPriceUpdate }))
vi.mock('../events', () => ({ publishPriceUpdate: mocks.publishPriceUpdate }))
vi.mock('../pairsRegistry', () => ({ getActivePairs: mocks.getActivePairs }))

// Per-network config the adapter reads. Both networks return the same shape here;
// a network-specific test overrides `phoenix` on one side when it needs to differ.
function makeNetworkConfig(network: 'testnet' | 'mainnet') {
  return {
    network: { passphrase: network === 'mainnet' ? 'Public Global Stellar Network ; September 2015' : 'Test SDF Network ; September 2015' },
    phoenix: {
      enabled: configState.enabled,
      factoryAddress: configState.blankFactory
        ? ''
        : network === 'mainnet' ? FACTORY_MAINNET : 'CBIFTP5CLUIVIVJ7WAMGOQPYPCV3CH3AVMHNWIL5XDPYCRWLBPUWL7FI',
      pollIntervalMs: 60_000,
      discoveryTtlMs: 300_000,
      tokenAddresses: [
        { key: 'XLM', tokenAddress: XLM_SAC },
        { key: 'USDC', tokenAddress: USDC_SAC },
      ],
    },
  }
}

vi.mock('../config', () => ({
  activeNetwork: 'testnet',
  getNetworkConfig: (network: 'testnet' | 'mainnet') => makeNetworkConfig(network),
}))

// Stub scValToNative to identity; keep the rest of the SDK real (StrKey, etc.).
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  return { ...actual, scValToNative: (v: unknown) => v }
})

// ── Imports ────────────────────────────────────────────────────────────────────
import {
  calcSpotPrice,
  decodePhoenixPools,
  decodePoolReserves,
  matchPoolToPair,
  derivePhoenixPricePoints,
  getPhoenixPools,
  resetPhoenixPoolCache,
  ingestPhoenixPair,
  simulateRead,
  phoenixAdapter,
  PHOENIX_SOURCE,
  type PhoenixPool,
} from '../ingest/venues/phoenix'
import type { WatchedPair } from '../types'

const pair: WatchedPair = {
  pairKey: 'USDC/XLM',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
}

/** A factory `query_all_pools_details` retval, shaped as scValToNative returns it. */
function factoryRetval(entries: unknown[]): unknown {
  return entries
}

function poolInfo(poolAddress: string, assetAAmount: string, assetBAmount: string): unknown {
  return {
    pool_address: poolAddress,
    pool_response: {
      asset_a: { address: XLM_SAC, amount: assetAAmount },
      asset_b: { address: USDC_SAC, amount: assetBAmount },
    },
    total_fee_bps: 30,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetPhoenixPoolCache()
  configState.enabled = true
  configState.blankFactory = false
})

// ── calcSpotPrice (reserve → price, incl. zero reserves) ───────────────────────
describe('calcSpotPrice', () => {
  it('derives price as the ratio of the two reserves', () => {
    expect(calcSpotPrice(10_000_000n, 2_000_000n)).toBeCloseTo(5.0)
  })

  it('returns 0 when the first reserve is zero (empty-pool guard, before dividing)', () => {
    expect(calcSpotPrice(0n, 2_000_000n)).toBe(0)
  })

  it('returns 0 when the second reserve is zero (no divide-by-zero, no Infinity)', () => {
    expect(calcSpotPrice(10_000_000n, 0n)).toBe(0)
  })

  it('returns 0 for a fully empty pool', () => {
    expect(calcSpotPrice(0n, 0n)).toBe(0)
  })

  it('guards against negative reserves from a corrupt read', () => {
    expect(calcSpotPrice(-5n, 100n)).toBe(0)
    expect(calcSpotPrice(100n, -5n)).toBe(0)
  })
})

// ── decodePhoenixPools (discovery decoding) ────────────────────────────────────
describe('decodePhoenixPools', () => {
  it('maps the factory pool list into pools with reserves as bigints', () => {
    const pools = decodePhoenixPools(factoryRetval([poolInfo(POOL1, '10000000', '2000000')]))
    expect(pools).toHaveLength(1)
    expect(pools[0]).toMatchObject({
      poolAddress: POOL1,
      tokenA: XLM_SAC,
      tokenB: USDC_SAC,
      reserveA: 10_000_000n,
      reserveB: 2_000_000n,
      totalFeeBps: 30,
    })
  })

  it('drops entries whose pool address is not a valid contract id', () => {
    const pools = decodePhoenixPools(factoryRetval([poolInfo('not-a-contract', '1', '1')]))
    expect(pools).toEqual([])
  })

  it('decodes multiple pools and drops only the malformed entry among valid ones', () => {
    const pools = decodePhoenixPools(
      factoryRetval([
        poolInfo(POOL1, '10000000', '2000000'),
        poolInfo('not-a-contract', '5', '5'),
        poolInfo(POOL2, '7000000', '1000000'),
      ])
    )
    expect(pools).toHaveLength(2)
    expect(pools.map((p) => p.poolAddress)).toEqual([POOL1, POOL2])
    expect(pools[1]).toMatchObject({ reserveA: 7_000_000n, reserveB: 1_000_000n })
  })

  it('drops entries whose balances cannot be read as integers', () => {
    const pools = decodePhoenixPools(factoryRetval([poolInfo(POOL1, 'abc', '2')]))
    expect(pools).toEqual([])
  })

  it('returns [] for a non-array retval (RPC returned something unexpected)', () => {
    expect(decodePhoenixPools({ not: 'an array' })).toEqual([])
  })
})

// ── matchPoolToPair (orientation) ──────────────────────────────────────────────
describe('matchPoolToPair', () => {
  const pool: PhoenixPool = {
    poolAddress: POOL1,
    tokenA: XLM_SAC,
    tokenB: USDC_SAC,
    reserveA: 1n,
    reserveB: 1n,
    totalFeeBps: 30,
  }

  it('reports direct when the pair assetA is the pool tokenA', () => {
    expect(matchPoolToPair(pool, pair, 'testnet')).toBe('direct')
  })

  it('reports swapped when the pair is reversed relative to the pool', () => {
    const reversed: WatchedPair = { ...pair, assetA: pair.assetB, assetB: pair.assetA }
    expect(matchPoolToPair(pool, reversed, 'testnet')).toBe('swapped')
  })

  it('returns null when the pool is not the pair', () => {
    const other: PhoenixPool = { ...pool, tokenB: 'CDOFW7HNKLUZRLFZST4EW7V3AV4JI5IHMT6BPXXSY2IEFZ4NE5TWU2P4' }
    expect(matchPoolToPair(other, pair, 'testnet')).toBeNull()
  })
})

// ── derivePhoenixPricePoints (reserve → written point) ─────────────────────────
describe('derivePhoenixPricePoints', () => {
  const pool: PhoenixPool = {
    poolAddress: POOL1,
    tokenA: XLM_SAC,
    tokenB: USDC_SAC,
    reserveA: 0n,
    reserveB: 0n,
    totalFeeBps: 30,
  }

  it('emits a phoenix_amm point with the pool address whole as poolId', () => {
    const points = derivePhoenixPricePoints(
      [{ pool, reserveA: 10_000_000n, reserveB: 2_000_000n }],
      pair,
      'testnet'
    )
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({
      source: PHOENIX_SOURCE,
      poolId: POOL1,
      pairKey: 'USDC/XLM',
      price: 5,
    })
  })

  it('emits nothing for a pool with zero reserves (empty-pool guard)', () => {
    const points = derivePhoenixPricePoints(
      [{ pool, reserveA: 0n, reserveB: 5_000_000n }],
      pair,
      'testnet'
    )
    expect(points).toEqual([])
  })

  it('skips a null read (unreachable pool) without throwing', () => {
    expect(derivePhoenixPricePoints([null], pair, 'testnet')).toEqual([])
  })

  it('never crosses orientations — a swapped pair quotes the reciprocal ratio', () => {
    const reversed: WatchedPair = { ...pair, assetA: pair.assetB, assetB: pair.assetA }
    const points = derivePhoenixPricePoints(
      [{ pool, reserveA: 10_000_000n, reserveB: 2_000_000n }],
      reversed,
      'testnet'
    )
    // pair assetA is now USDC → the pool's tokenB, so the ratio flips to 0.2.
    expect(points[0].price).toBeCloseTo(0.2)
  })
})

// ── getPhoenixPools (discovery is cached with a TTL, not per request) ──────────
describe('getPhoenixPools discovery cache', () => {
  it('fetches once and serves the cache until the TTL elapses', async () => {
    const fetcher = vi.fn().mockResolvedValue([
      {
        poolAddress: POOL1,
        tokenA: XLM_SAC,
        tokenB: USDC_SAC,
        reserveA: 10_000_000n,
        reserveB: 2_000_000n,
        totalFeeBps: 30,
      },
    ])

    await getPhoenixPools('testnet', fetcher)
    const second = await getPhoenixPools('testnet', fetcher)

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(second).toHaveLength(1)
  })

  it('refetches after the TTL expires', async () => {
    const fetcher = vi.fn().mockResolvedValue([])
    // discoveryTtlMs is 300_000 in the mocked config.
    const nowSpy = vi.spyOn(Date, 'now')

    nowSpy.mockReturnValue(1_000_000)
    await getPhoenixPools('testnet', fetcher)
    nowSpy.mockReturnValue(1_000_000 + 300_001)
    await getPhoenixPools('testnet', fetcher)

    expect(fetcher).toHaveBeenCalledTimes(2)
    nowSpy.mockRestore()
  })

  it('keys the cache per network so mainnet never serves testnet pool sets', async () => {
    const fetcher = vi.fn().mockResolvedValue([
      { poolAddress: POOL1, tokenA: XLM_SAC, tokenB: USDC_SAC, reserveA: 1n, reserveB: 1n, totalFeeBps: 30 },
    ])

    await getPhoenixPools('testnet', fetcher)
    await getPhoenixPools('mainnet', fetcher)

    // Separate networks → separate cache entries → two distinct fetches, each
    // against that network's own factory id.
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'CBIFTP5CLUIVIVJ7WAMGOQPYPCV3CH3AVMHNWIL5XDPYCRWLBPUWL7FI',
      'testnet'
    )
    expect(fetcher).toHaveBeenNthCalledWith(2, FACTORY_MAINNET, 'mainnet')
  })

  it('keeps serving the previous list when a re-discovery transiently returns empty', async () => {
    const ok = [
      { poolAddress: POOL1, tokenA: XLM_SAC, tokenB: USDC_SAC, reserveA: 1n, reserveB: 1n, totalFeeBps: 30 },
    ]
    const fetcher = vi.fn().mockResolvedValueOnce(ok)
    await getPhoenixPools('testnet', fetcher)

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 300_001)
    fetcher.mockResolvedValueOnce([]) // factory unreachable this cycle
    const served = await getPhoenixPools('testnet', fetcher)

    expect(served).toHaveLength(1)
    nowSpy.mockRestore()
  })

  it('returns [] without calling the factory when the venue is disabled on the network', async () => {
    configState.enabled = false
    const fetcher = vi.fn()
    const pools = await getPhoenixPools('testnet', fetcher)
    expect(pools).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('returns [] without calling the factory when no factory id is configured', async () => {
    configState.blankFactory = true
    const fetcher = vi.fn()
    const pools = await getPhoenixPools('testnet', fetcher)
    expect(pools).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
})

// ── ingestPhoenixPair (writes its own network; degrades, never throws) ─────────
describe('ingestPhoenixPair', () => {
  const pool: PhoenixPool = {
    poolAddress: POOL1,
    tokenA: XLM_SAC,
    tokenB: USDC_SAC,
    reserveA: 0n,
    reserveB: 0n,
    totalFeeBps: 30,
  }

  it('writes a phoenix_amm point tagged with the network it read from', async () => {
    const deps = {
      getPhoenixPools: vi.fn().mockResolvedValue([pool]),
      fetchPoolReserves: vi.fn().mockResolvedValue({ pool, reserveA: 10_000_000n, reserveB: 2_000_000n }),
    }

    await ingestPhoenixPair(pair, 'mainnet', deps)

    expect(mocks.upsertPricePoints).toHaveBeenCalledTimes(1)
    const [rows, network] = mocks.upsertPricePoints.mock.calls[0]
    expect(network).toBe('mainnet')
    expect(rows[0]).toMatchObject({ source: 'phoenix_amm', poolId: POOL1, price: 5 })
  })

  it('runs one instance per network and never writes the wrong network', async () => {
    const depsFor = (reserveA: bigint) => ({
      getPhoenixPools: vi.fn().mockResolvedValue([pool]),
      fetchPoolReserves: vi.fn().mockResolvedValue({ pool, reserveA, reserveB: 100_000_000n }),
    })

    await ingestPhoenixPair(pair, 'testnet', depsFor(8_000_000n))
    await ingestPhoenixPair(pair, 'mainnet', depsFor(12_000_000n))

    expect(mocks.upsertPricePoints.mock.calls[0][1]).toBe('testnet')
    expect(mocks.upsertPricePoints.mock.calls[1][1]).toBe('mainnet')
  })

  it('writes nothing when the only pool has zero reserves', async () => {
    const deps = {
      getPhoenixPools: vi.fn().mockResolvedValue([pool]),
      fetchPoolReserves: vi.fn().mockResolvedValue({ pool, reserveA: 0n, reserveB: 0n }),
    }

    await ingestPhoenixPair(pair, 'testnet', deps)
    expect(mocks.upsertPricePoints).not.toHaveBeenCalled()
  })

  it('degrades (writes nothing, does not throw) when reserves are unreadable', async () => {
    const deps = {
      getPhoenixPools: vi.fn().mockResolvedValue([pool]),
      fetchPoolReserves: vi.fn().mockResolvedValue(null),
    }

    await expect(ingestPhoenixPair(pair, 'testnet', deps)).resolves.toBeUndefined()
    expect(mocks.upsertPricePoints).not.toHaveBeenCalled()
  })

  it('degrades when discovery itself throws — the process is never crashed', async () => {
    const deps = {
      getPhoenixPools: vi.fn().mockRejectedValue(new Error('RPC down')),
      fetchPoolReserves: vi.fn(),
    }

    await expect(ingestPhoenixPair(pair, 'testnet', deps)).resolves.toBeUndefined()
    expect(mocks.upsertPricePoints).not.toHaveBeenCalled()
  })

  it('skips quietly when no discovered pool quotes the pair', async () => {
    const other: PhoenixPool = { ...pool, tokenB: 'CDOFW7HNKLUZRLFZST4EW7V3AV4JI5IHMT6BPXXSY2IEFZ4NE5TWU2P4' }
    const deps = {
      getPhoenixPools: vi.fn().mockResolvedValue([other]),
      fetchPoolReserves: vi.fn(),
    }

    await ingestPhoenixPair(pair, 'testnet', deps)
    expect(deps.fetchPoolReserves).not.toHaveBeenCalled()
    expect(mocks.upsertPricePoints).not.toHaveBeenCalled()
  })
})

// ── simulateRead fault isolation ───────────────────────────────────────────────
describe('simulateRead', () => {
  it('returns null (not a throw) for a non-contract id, without touching the RPC', async () => {
    await expect(simulateRead('GAAAAAAA', 'query_pool_info', 'testnet')).resolves.toBeNull()
  })
})

// ── decodePoolReserves ─────────────────────────────────────────────────────────
describe('decodePoolReserves', () => {
  it('decodes a pool info retval into a reserve snapshot in the pool order', () => {
    const decoded = decodePoolReserves(
      { asset_a: { address: XLM_SAC, amount: '500' }, asset_b: { address: USDC_SAC, amount: '250' } },
      { poolAddress: POOL1, tokenA: XLM_SAC, tokenB: USDC_SAC, reserveA: 0n, reserveB: 0n, totalFeeBps: 30 }
    )
    expect(decoded).toMatchObject({ reserveA: 500n, reserveB: 250n })
  })

  it('returns null when the retval is missing an asset side', () => {
    expect(
      decodePoolReserves({ asset_a: { address: XLM_SAC, amount: '500' } }, {
        poolAddress: POOL1, tokenA: XLM_SAC, tokenB: USDC_SAC, reserveA: 0n, reserveB: 0n, totalFeeBps: 30,
      })
    ).toBeNull()
  })
})

// ── Adapter surface ────────────────────────────────────────────────────────────
describe('phoenixAdapter', () => {
  it('reports its own name and source', () => {
    expect(phoenixAdapter.name).toBe('Phoenix')
    expect(phoenixAdapter.source).toBe('phoenix_amm')
  })

  it('reads enabled state and poll interval per network', () => {
    expect(phoenixAdapter.isEnabled('testnet')).toBe(true)
    expect(phoenixAdapter.isEnabled('mainnet')).toBe(true)
    expect(phoenixAdapter.getPollIntervalMs('mainnet')).toBe(60_000)
  })
})
