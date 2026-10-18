/**
 * Unit tests for the Coinbase CEX adapter (issue #215).
 *
 * Everything here stubs fetch — no real exchange is called — following the
 * repo's existing ingester-test pattern (global.fetch = vi.fn()).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createCexAdapter,
  getCexAdapter,
  getAllCexAdapters,
  KNOWN_CEX_EXCHANGES,
} from '../ingest/cex/index'
import {
  CoinbaseCexAdapter,
  COINBASE_SOURCE,
  TokenBucket,
  fromCoinbaseProductId,
  toCoinbaseProductId,
} from '../ingest/cex/coinbase'
import type { CoinbaseAdapterOptions } from '../ingest/cex/coinbase'

// Response shape verified against Coinbase Exchange public /products/{id}/ticker
// docs and published examples: strings for every numeric field.
const XLM_USD_TICKER = {
  trade_id: 7423739,
  price: '0.10050',
  size: '0.005',
  bid: '0.10040',
  ask: '0.10060',
  volume: '1250.75',
  time: '2026-10-18T10:06:15.234Z',
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(headers),
  }
}

function makeAdapter(responses: Array<ReturnType<typeof jsonResponse> | Error>, options: Partial<CoinbaseAdapterOptions> = {}) {
  const fetchMock = vi.fn()
  for (const r of responses) {
    if (r instanceof Error) fetchMock.mockRejectedValueOnce(r)
    else fetchMock.mockResolvedValueOnce(r)
  }
  const sleepSpy = vi.fn(async () => {})
  const adapter = new CoinbaseCexAdapter({
    fetchImpl: fetchMock as unknown as typeof fetch,
    sleep: sleepSpy,
    ...options,
  })
  return { adapter, fetchMock, sleepSpy }
}

describe('Coinbase pair normalisation (both directions)', () => {
  it('canonical base+quote → Coinbase product id (dash, upper-case)', () => {
    expect(toCoinbaseProductId('XLM', 'USDC')).toBe('XLM-USDC')
    // Lower-case input is the whole point of "normalised".
    expect(toCoinbaseProductId('xlm', 'usdc')).toBe('XLM-USDC')
    expect(toCoinbaseProductId(' btc ', 'usd')).toBe('BTC-USD')
  })

  it('Coinbase product id → canonical pair ("the exchange names it differently")', () => {
    // Coinbase spells the pair XLM-USDC; Lens spells it XLM/USDC.
    expect(fromCoinbaseProductId('XLM-USDC')).toBe('XLM/USDC')
    expect(fromCoinbaseProductId('btc-usd')).toBe('BTC/USD')
  })

  it('round-trips in both directions', () => {
    expect(fromCoinbaseProductId(toCoinbaseProductId('xlm', 'usdc')!)).toBe('XLM/USDC')
    expect(toCoinbaseProductId(...(fromCoinbaseProductId('ETH-USDT')!.split('/') as [string, string]))).toBe('ETH-USDT')
  })

  it('rejects malformed inputs instead of building bogus product ids', () => {
    expect(toCoinbaseProductId('', 'USD')).toBeNull()
    expect(toCoinbaseProductId('XLM-USD', 'USDC')).toBeNull() // a dash inside a symbol
    expect(toCoinbaseProductId('XLM', 'a/b')).toBeNull() // a slash would poison the pair key
    expect(fromCoinbaseProductId('BTCUSD')).toBeNull() // no separator
    expect(fromCoinbaseProductId('')).toBeNull()
    expect(fromCoinbaseProductId('XLM-USDC-2021')).toBeNull() // more than one separator
  })
})

describe('CoinbaseCexAdapter.fetchTicker', () => {
  it('fetches the dashed product id and returns the canonical pair', async () => {
    const { adapter, fetchMock } = makeAdapter([jsonResponse(XLM_USD_TICKER)])

    const ticker = await adapter.fetchTicker('xlm', 'usdc')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String(fetchMock.mock.calls[0][0])
    // The exchange-side name is the dash form…
    expect(url).toContain('https://api.exchange.coinbase.com/products/XLM-USDC/ticker')
    // …but the ticker reports the canonical slash form.
    expect(ticker).not.toBeNull()
    expect(ticker!.pair).toBe('XLM/USDC')
  })

  it('parses the documented string fields into numbers and stamps the source', async () => {
    const { adapter } = makeAdapter([jsonResponse(XLM_USD_TICKER)])

    const ticker = await adapter.fetchTicker('XLM', 'USD')

    expect(ticker!.bid).toBeCloseTo(0.1004)
    expect(ticker!.ask).toBeCloseTo(0.1006)
    expect(ticker!.last).toBeCloseTo(0.1005)
    expect(ticker!.baseVolume).toBeCloseTo(1250.75)
    // Coinbase publishes no quote volume; it is a flagged estimate, never silent.
    expect(ticker!.quoteVolume).toBeGreaterThan(0)
    expect(ticker!.quoteVolumeEstimated).toBe(true)
    expect(ticker!.source).toBe(COINBASE_SOURCE)
    expect(ticker!.timestamp).toBeInstanceOf(Date)
    expect(ticker!.timestamp.toISOString()).toBe('2026-10-18T10:06:15.234Z')
  })

  it('returns null for an unknown pair (HTTP 404) without retrying', async () => {
    const { adapter, fetchMock, sleepSpy } = makeAdapter([jsonResponse({ message: 'Product Not Public' }, 404)])

    const ticker = await adapter.fetchTicker('XLM', 'NOTAREALCOIN')

    expect(ticker).toBeNull()
    // A 404 is definitive — no retries, no backoff, no rate-limit spend.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleepSpy).not.toHaveBeenCalled()
  })

  it('degrades to null on a body that does not quote, never invents numbers', async () => {
    const { adapter } = makeAdapter([jsonResponse({ trade_id: 1, time: '2026-01-01T00:00:00Z' })])
    // price/bid/ask/volume absent → "no Coinbase price", not a guessed one.
    expect(await adapter.fetchTicker('XLM', 'USD')).toBeNull()
  })

  it('degrades to null on a non-JSON body', async () => {
    const broken = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
      headers: new Headers(),
    }
    const { adapter } = makeAdapter([broken as ReturnType<typeof jsonResponse>])
    expect(await adapter.fetchTicker('XLM', 'USD')).toBeNull()
  })

  it('accepts a malformed base+quote without ever calling fetch', async () => {
    const { adapter, fetchMock } = makeAdapter([])
    expect(await adapter.fetchTicker('XLM-USD', 'USDC')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('CoinbaseCexAdapter rate limiting & 429 backoff', () => {
  it('paces calls to the configured limit: a 10 rps / burst-1 bucket sleeps 100ms on the second call', async () => {
    const { adapter, fetchMock, sleepSpy } = makeAdapter(
      [jsonResponse(XLM_USD_TICKER), jsonResponse(XLM_USD_TICKER)],
      { requestsPerSecond: 10, burstCapacity: 1, now: () => 0 }
    )

    await adapter.fetchTicker('XLM', 'USD')
    await adapter.fetchTicker('BTC', 'USD')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Burst is 1, so the second acquire owes a full token: 1/10s = 100ms.
    expect(sleepSpy).toHaveBeenCalledWith(100)
  })

  it('TokenBucket honours the published burst, then the sustained 10 rps, and refills over time', () => {
    let nowMs = 0
    const bucket = new TokenBucket({ requestsPerSecond: 10, burstCapacity: 15, now: () => nowMs })

    // The published burst: first 15 requests are free.
    for (let i = 0; i < 15; i++) expect(bucket.acquire()).toBe(0)
    // The 16th and 17th queue behind the sustained rate: 100ms, then 200ms.
    expect(bucket.acquire()).toBe(100)
    expect(bucket.acquire()).toBe(200)

    // One second later the bucket has refilled to capacity.
    nowMs += 1000
    expect(bucket.acquire()).toBe(0)
  })

  it('backs off on a stubbed 429 for exactly the Retry-After Coinbase sends, then succeeds', async () => {
    const { adapter, fetchMock, sleepSpy } = makeAdapter([
      jsonResponse({}, 429, { 'Retry-After': '3' }),
      jsonResponse(XLM_USD_TICKER),
    ])

    const ticker = await adapter.fetchTicker('XLM', 'USD')

    expect(ticker).not.toBeNull()
    expect(ticker!.last).toBeCloseTo(0.1005)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 3 seconds is Coinbase's own word; we wait for it, not a guess.
    expect(sleepSpy).toHaveBeenCalledWith(3000)
  })

  it('backs off exponentially on 429s without Retry-After', async () => {
    const { adapter, sleepSpy } = makeAdapter([
      jsonResponse({}, 429),
      jsonResponse({}, 429),
      jsonResponse(XLM_USD_TICKER),
    ])

    const ticker = await adapter.fetchTicker('XLM', 'USD')

    expect(ticker).not.toBeNull()
    expect(sleepSpy.mock.calls.map((c) => c[0])).toEqual([1000, 2000])
  })

  it('retries transient 5xx like an outage', async () => {
    const { adapter, sleepSpy } = makeAdapter([
      jsonResponse({}, 503),
      jsonResponse(XLM_USD_TICKER),
    ])

    expect(await adapter.fetchTicker('XLM', 'USD')).not.toBeNull()
    expect(sleepSpy).toHaveBeenCalledWith(1000)
  })

  it('gives up to null after maxRetries 429s — it never becomes an error', async () => {
    const { adapter, fetchMock, sleepSpy } = makeAdapter(
      [
        jsonResponse({}, 429),
        jsonResponse({}, 429),
        jsonResponse({}, 429),
        jsonResponse({}, 429),
        jsonResponse({}, 429),
      ],
      { maxRetries: 3 }
    )

    const ticker = await adapter.fetchTicker('XLM', 'USD')

    expect(ticker).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(4) // first try + 3 retries
    // Backoff is capped; nothing sleeps forever, nothing throws.
    for (const [ms] of sleepSpy.mock.calls) expect(ms).toBeLessThanOrEqual(30_000)
  })
})

describe('Coinbase exchange outage degrades, never propagates', () => {
  it('a rejected fetch (DNS/socket down) resolves to null after bounded retries', async () => {
    const { adapter, fetchMock } = makeAdapter(
      [
        new Error('getaddrinfo ENOTFOUND api.exchange.coinbase.com'),
        new Error('socket hang up'),
      ],
      { maxRetries: 1 }
    )

    await expect(adapter.fetchTicker('XLM', 'USD')).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('an unparseable product id returns null without touching the network', async () => {
    const { adapter, fetchMock } = makeAdapter([])
    await expect(adapter.fetchTicker(undefined as unknown as string, 'USD')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetchOrderBook degrades the same way (404 → null)', async () => {
    const { adapter } = makeAdapter([jsonResponse({ message: 'not found' }, 404)])
    await expect(adapter.fetchOrderBook('XLM', 'USD')).resolves.toBeNull()
  })
})

describe('CoinbaseCexAdapter.fetchOrderBook', () => {
  it('returns the top-of-book levels it can actually source', async () => {
    const { adapter, fetchMock } = makeAdapter([
      jsonResponse({
        sequence: 40,
        bids: [['0.1004', '1500.0', 3]],
        asks: [['0.1006', '900.5', 2]],
        timestamp: '2026-10-18T10:06:15.000Z',
      }),
    ])

    const book = await adapter.fetchOrderBook('xlm', 'usd')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/products/XLM-USD/book?level=1')
    expect(book!.pair).toBe('XLM/USD')
    expect(book!.bids).toEqual([{ price: 0.1004, quantity: 1500.0 }])
    expect(book!.asks).toEqual([{ price: 0.1006, quantity: 900.5 }])
    expect(book!.timestamp.toISOString()).toBe('2026-10-18T10:06:15.000Z')
  })
})

describe('createCexAdapter registry (#215)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds and registers the Coinbase adapter through createCexAdapter', () => {
    expect(KNOWN_CEX_EXCHANGES).toContain('coinbase')

    const adapter = createCexAdapter('Coinbase') // case-insensitive lookup

    expect(adapter).toBeInstanceOf(CoinbaseCexAdapter)
    expect(adapter!.name).toBe('coinbase')
    expect(getCexAdapter('coinbase')).toBe(adapter)
    expect(getAllCexAdapters()).toContain(adapter)
  })

  it('unknown exchanges drop the venue with a loud log — they never crash the caller', () => {
    expect(createCexAdapter('kraken')).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('kraken'))
    expect(getCexAdapter('kraken')).toBeUndefined()
  })
})
