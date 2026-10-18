/**
 * Coinbase CEX Adapter
 *
 * The first real implementation of CexAdapter (issue #215): Coinbase Exchange
 * public market data over HTTPS, no API key, no auth. It fetches the ticker,
 * normalises the product identifier ("XLM-USDC") into Lens's canonical pair
 * form ("XLM/USDC"), and stamps every ticker with `source = 'coinbase'` so a
 * CEX number can never be mistaken for — or blended with — an on-chain one.
 *
 * Verified response shape (docs and published examples, GET
 * https://api.exchange.coinbase.com/products/{product_id}/ticker):
 *   { "trade_id": …, "price": "…", "size": "…", "bid": "…", "ask": "…",
 *     "volume": "…", "time": "…" }
 * with 404 for an unknown product id.
 *
 * Rate limiting follows Coinbase's published public-endpoint limit — 10
 * requests per second per IP, in bursts of up to 15 — with a token bucket in
 * front of every call. When we still exceed it Coinbase answers HTTP 429; the
 * adapter honors Retry-After when present, otherwise exponential backoff with
 * a ceiling, and gives up by returning null.
 *
 * Failure mode is "no Coinbase price", never an exception and never an error
 * response: a dead exchange, a timeout, a persistent 429 or a garbage body all
 * degrade this venue to null while every other price in the system keeps
 * working. Adapters stay stateless fetch wrappers — no caching, per the
 * CexAdapter contract; only the rate-bucket clock is in-memory.
 *
 * One honesty caveat: Coinbase's public ticker publishes the 24h volume in
 * BASE-asset units only; no public Coinbase endpoint publishes a quote-asset
 * volume. Rather than invent one silently, `quoteVolume` is computed as
 * `last × baseVolume` and every such ticker carries
 * `quoteVolumeEstimated: true` so consumers can tell sourced from derived.
 *
 * Issue: #215
 */

import type { CexAdapter, CexOrderBook, CexOrderBookLevel, CexTicker } from './index'

/** Value for `source` on anything built from this adapter's data. */
export const COINBASE_SOURCE = 'coinbase'

const DEFAULT_BASE_URL = 'https://api.exchange.coinbase.com'

/**
 * Coinbase's published public-REST limit: 10 requests per second per IP,
 * in bursts of up to 15. Keeping the numbers here, in one comment, is the
 * point — raise them in code and you are just choosing your ban.
 */
const PUBLISHED_REQUESTS_PER_SECOND = 10
const PUBLISHED_BURST_CAPACITY = 15

/** Coinbase product ids: two asset symbols joined by a single '-'. */
const PRODUCT_ID_RE = /^[A-Z0-9.]+-[A-Z0-9.]+$/
const ASSET_SYMBOL_RE = /^[A-Z0-9.]{1,12}$/

// ── Pair normalisation ────────────────────────────────────────────────────────

/**
 * Pure: canonical base+quote → Coinbase product id. Coinbase names pairs with
 * a dash, not a slash, and upper-case symbols — fetchTicker('xlm', 'usdc')
 * must query XLM-USDC. Returns null for anything that cannot be a symbol
 * (empty, embedded dash, absurd length) so a malformed pair never reaches the
 * URL as a path-injection vector.
 */
export function toCoinbaseProductId(base: string, quote: string): string | null {
  if (typeof base !== 'string' || typeof quote !== 'string') return null
  const b = base.trim().toUpperCase()
  const q = quote.trim().toUpperCase()
  if (!ASSET_SYMBOL_RE.test(b) || !ASSET_SYMBOL_RE.test(q)) return null
  return `${b}-${q}`
}

/**
 * Pure: Coinbase product id → canonical "BASE/QUOTE" pair identifier.
 * "XLM-USDC" → "XLM/USDC"; anything the shape rejects returns null. This is
 * the same normalisation run over the response's own product form, so the
 * pair a ticker reports is always the canonical one regardless of how the
 * exchange spells it internally.
 */
export function fromCoinbaseProductId(productId: string): string | null {
  if (typeof productId !== 'string') return null
  const id = productId.trim().toUpperCase()
  if (!PRODUCT_ID_RE.test(id)) return null
  const sep = id.indexOf('-')
  return `${id.slice(0, sep)}/${id.slice(sep + 1)}`
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

/**
 * Classic token bucket, injectable clock so tests can hold time still.
 * `acquire()` consumes a token and returns how long the caller must wait
 * before the request stays inside the published limit — concurrent callers
 * queue deterministically because the debt (-tokens) accumulates.
 */
export interface TokenBucketOptions {
  requestsPerSecond?: number
  burstCapacity?: number
  now?: () => number
}

export class TokenBucket {
  private readonly rate: number
  private readonly capacity: number
  private readonly now: () => number
  private tokens: number
  private lastRefill: number

  constructor(options: TokenBucketOptions = {}) {
    this.rate = options.requestsPerSecond ?? PUBLISHED_REQUESTS_PER_SECOND
    this.capacity = options.burstCapacity ?? PUBLISHED_BURST_CAPACITY
    this.now = options.now ?? Date.now
    this.tokens = this.capacity
    this.lastRefill = this.now()
  }

  /** Consume one token; returns the ms the caller must sleep before sending. */
  acquire(): number {
    const now = this.now()
    const elapsedMs = Math.max(0, now - this.lastRefill)
    this.lastRefill = now
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs * this.rate) / 1000)
    this.tokens -= 1
    if (this.tokens >= 0) return 0
    return Math.ceil((-this.tokens / this.rate) * 1000)
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export interface CoinbaseAdapterOptions {
  /** Override for tests / self-hosted proxies. Default api.exchange.coinbase.com. */
  baseUrl?: string
  /** Injectable fetch (tests stub this). Default is the global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable sleep so backoff is testable without burning wall time. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Publishes of the bucket; default to Coinbase's own published numbers. */
  requestsPerSecond?: number
  burstCapacity?: number
  /** Additional attempts after the first for 429/5xx/network errors. */
  maxRetries?: number
  /** Exponential backoff geometry for 429 without Retry-After, and 5xx. */
  backoffBaseMs?: number
  backoffCapMs?: number
  /** Per-request timeout; AbortSignal is skipped if the runtime lacks it. */
  requestTimeoutMs?: number
}

type JsonRecord = Record<string, unknown>

interface CoinbaseBookLevel {
  price?: string | number
  quantity?: string | number
  size?: string | number
}
type CoinbaseBookEntry = CoinbaseBookLevel | readonly (string | number)[]

export class CoinbaseCexAdapter implements CexAdapter {
  readonly name = COINBASE_SOURCE

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number
  private readonly backoffBaseMs: number
  private readonly backoffCapMs: number
  private readonly requestTimeoutMs: number
  private readonly bucket: TokenBucket

  constructor(options: CoinbaseAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.maxRetries = options.maxRetries ?? 3
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000
    this.backoffCapMs = options.backoffCapMs ?? 30_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.bucket = new TokenBucket({
      requestsPerSecond: options.requestsPerSecond,
      burstCapacity: options.burstCapacity,
      now: options.now,
    })
  }

  /**
   * Fetch the latest ticker for BASE-QUOTE. Returns null — never throws —
   * when the pair is unknown (HTTP 404), the exchange is unreachable or
   * rate-limited past our retries, or the body is not quotable.
   */
  async fetchTicker(base: string, quote: string): Promise<CexTicker | null> {
    try {
      const productId = toCoinbaseProductId(base, quote)
      if (!productId) {
        console.debug(`[coinbase] cannot map ${base}/${quote} to a product id — no price`)
        return null
      }

      const data = await this.getJson(`/products/${encodeURIComponent(productId)}/ticker`)
      if (!data) return null

      const last = positiveNumber(data.price)
      const bid = positiveNumber(data.bid)
      const ask = positiveNumber(data.ask)
      const baseVolume = nonNegativeNumber(data.volume)
      if (last === null || bid === null || ask === null || baseVolume === null) {
        // A body that parses but does not quote is "no Coinbase price" — we
        // never fill gaps with invented numbers.
        console.debug(`[coinbase] ticker for ${productId} is not quotable (missing/invalid fields)`)
        return null
      }

      return {
        pair: fromCoinbaseProductId(productId) ?? productId,
        bid,
        ask,
        last,
        baseVolume,
        // Coinbase publishes no quote-asset volume; see the header comment.
        quoteVolume: round6(last * baseVolume),
        quoteVolumeEstimated: true,
        source: this.name,
        timestamp: parseTimestamp(data.time),
      }
    } catch (err) {
      console.error(`[coinbase] fetchTicker(${base}/${quote}) failed:`, (err as Error).message)
      return null
    }
  }

  /**
   * Order book snapshot. Coinbase Exchange only serves the aggregated top
   * level (book?level=1) without authentication, so this returns one level
   * per side — the honest sourceable answer — rather than inventing depth.
   * The `depth` argument is accepted for interface compatibility; it can
   * never yield more than the one level the public endpoint carries.
   */
  async fetchOrderBook(base: string, quote: string, depth = 20): Promise<CexOrderBook | null> {
    try {
      const productId = toCoinbaseProductId(base, quote)
      if (!productId) return null

      const data = await this.getJson(`/products/${encodeURIComponent(productId)}/book?level=1`)
      if (!data) return null

      const bids = parseBookSide(data.bids, depth)
      const asks = parseBookSide(data.asks, depth)
      if (bids.length === 0 || asks.length === 0) {
        console.debug(`[coinbase] book for ${productId} has no quotable top level`)
        return null
      }

      return {
        pair: fromCoinbaseProductId(productId) ?? productId,
        bids,
        asks,
        timestamp: parseTimestamp(data.timestamp ?? data.time),
      }
    } catch (err) {
      console.error(`[coinbase] fetchOrderBook(${base}/${quote}) failed:`, (err as Error).message)
      return null
    }
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────

  /**
   * GET a public path, rate-limited through the bucket, backing off on 429
   * and 5xx, and returning null on 404 or exhaustion. Never throws: every
   * transport failure ends as "no Coinbase price".
   */
  private async getJson(path: string): Promise<JsonRecord | null> {
    const url = `${this.baseUrl}${path}`

    for (let attempt = 0; ; attempt++) {
      const waitMs = this.bucket.acquire()
      if (waitMs > 0) await this.sleep(waitMs)

      let res: Response
      try {
        const init: RequestInit = { headers: { Accept: 'application/json' } }
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          init.signal = AbortSignal.timeout(this.requestTimeoutMs)
        }
        res = await this.fetchImpl(url, init)
      } catch (err) {
        // Network failure — the exchange (or DNS, or the socket) is down for
        // us. Counted as a retryable outage, never propagated.
        console.debug(`[coinbase] ${path} network error:`, (err as Error).message)
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoffMs(attempt))
          continue
        }
        console.warn(`[coinbase] ${path} unreachable after ${attempt + 1} attempts — degrading to no price`)
        return null
      }

      if (res.status === 404) return null

      if (res.ok) {
        try {
          const body = (await res.json()) as unknown
          if (body && typeof body === 'object' && !Array.isArray(body)) return body as JsonRecord
          console.debug(`[coinbase] ${path} returned a non-object body — no price`)
          return null
        } catch (err) {
          console.debug(`[coinbase] ${path} body was not valid JSON:`, (err as Error).message)
          return null
        }
      }

      const transient = res.status === 429 || res.status >= 500
      if (!transient) {
        // Any other 4xx is our request being wrong, not the exchange being
        // busy; retrying it just spends limit we don't have.
        console.debug(`[coinbase] ${path} rejected with HTTP ${res.status} — no price`)
        return null
      }

      if (attempt >= this.maxRetries) {
        console.warn(`[coinbase] ${path} rate-limited/erroring (HTTP ${res.status}) after ${attempt + 1} attempts — degrading to no price`)
        return null
      }

      // 429: back off as long as Coinbase says, if it says; else our own
      // exponential curve. 5xx: same curve, the outage isn't telling us times.
      const delay = res.status === 429 ? (retryAfterMs(res.headers) ?? this.backoffMs(attempt)) : this.backoffMs(attempt)
      console.debug(`[coinbase] ${path} got HTTP ${res.status}, retrying in ${delay}ms (attempt ${attempt + 2}/${this.maxRetries + 1})`)
      await this.sleep(delay)
    }
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** attempt)
  }
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

function retryAfterMs(headers: Headers): number | null {
  try {
    const raw = typeof headers?.get === 'function' ? headers.get('Retry-After') : null
    if (!raw) return null
    const secs = Number(raw.trim())
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000)
    const when = Date.parse(raw)
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now())
    return null
  } catch {
    return null
  }
}

function parseBookSide(levels: unknown, depth: number): CexOrderBookLevel[] {
  if (!Array.isArray(levels)) return []
  const out: CexOrderBookLevel[] = []
  for (const level of levels.slice(0, Math.max(1, depth))) {
    const parsed = parseBookLevel(level)
    if (parsed) out.push(parsed)
  }
  return out
}

/** level-1 book entries arrive as [price, size, num-orders]; accept objects too. */
function parseBookLevel(level: unknown): CexOrderBookLevel | null {
  let rawPrice: unknown
  let rawQty: unknown
  if (Array.isArray(level)) {
    rawPrice = level[0]
    rawQty = level[1]
  } else if (level && typeof level === 'object') {
    const obj = level as CoinbaseBookLevel
    rawPrice = obj.price
    rawQty = obj.quantity ?? obj.size
  } else {
    return null
  }
  const price = positiveNumber(rawPrice)
  const quantity = nonNegativeNumber(rawQty)
  if (price === null || quantity === null) return null
  return { price, quantity }
}

function parseTimestamp(raw: unknown): Date {
  if (typeof raw === 'string' || typeof raw === 'number') {
    const t = new Date(raw)
    if (!Number.isNaN(t.getTime())) return t
  }
  return new Date()
}

function positiveNumber(raw: unknown): number | null {
  const n = toNumber(raw)
  return n !== null && n > 0 ? n : null
}

function nonNegativeNumber(raw: unknown): number | null {
  const n = toNumber(raw)
  return n !== null && n >= 0 ? n : null
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function round6(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0
}
