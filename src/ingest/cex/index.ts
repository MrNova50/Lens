/**
 * CEX Adapter Interface
 *
 * Defines the contract every centralized-exchange adapter must satisfy.
 * Concrete adapters (Coinbase, Binance, Kraken, …) implement CexAdapter and
 * are registered via createCexAdapter so callers stay exchange-agnostic.
 *
 * Issue: #99, #215
 */

// Value import for the registry factory; coinbase.ts imports only *types*
// from this module, so there is no runtime cycle.
import { CoinbaseCexAdapter, type CoinbaseAdapterOptions } from './coinbase'

/** Best bid/ask + last-trade snapshot for a single trading pair. */
export interface CexTicker {
  /** Exchange-normalized pair identifier, e.g. "XLM/USDC". */
  pair: string
  bid: number
  ask: number
  /** Price of the most recent trade. */
  last: number
  /** 24 h base-asset volume. */
  baseVolume: number
  /**
   * 24 h quote-asset volume. Some exchanges do not publish one for every
   * pair; when the number is derived rather than sourced, the adapter must
   * set {@link CexTicker.quoteVolumeEstimated} — a figure you cannot source
   * must never masquerade as a figure you can.
   */
  quoteVolume: number
  /** True when quoteVolume is a documented estimate, not an exchange figure. */
  quoteVolumeEstimated?: boolean
  /**
   * Venue label this ticker came from — the `name` of the adapter that
   * produced it. Consumers writing price_points MUST copy this into the row's
   * `source` so a CEX price is never mistaken for, blended with, or averaged
   * into an on-chain one.
   */
  source?: string
  timestamp: Date
}

/** Single resting order in the order book. */
export interface CexOrderBookLevel {
  price: number
  quantity: number
}

/** Aggregated order book snapshot. */
export interface CexOrderBook {
  pair: string
  bids: CexOrderBookLevel[]
  asks: CexOrderBookLevel[]
  timestamp: Date
}

/**
 * Every CEX adapter must implement this interface.
 *
 * Adapters are stateless fetch wrappers — they must not cache or store data
 * themselves; caching is the caller's responsibility.
 */
export interface CexAdapter {
  /** Human-readable exchange identifier used in logs and metrics labels. */
  readonly name: string

  /**
   * Fetch the latest ticker for a trading pair.
   * Returns null when the pair is unknown or the exchange is unreachable.
   */
  fetchTicker(base: string, quote: string): Promise<CexTicker | null>

  /**
   * Fetch an order book snapshot.
   * Optional — adapters that do not expose an order book may omit this method.
   *
   * @param depth Maximum number of levels on each side (default 20).
   */
  fetchOrderBook?(base: string, quote: string, depth?: number): Promise<CexOrderBook | null>
}

/**
 * Registry of all registered adapters, keyed by name.
 * Populated via registerCexAdapter / createCexAdapter; consumed via
 * getCexAdapter / getAllCexAdapters.
 */
const _registry = new Map<string, CexAdapter>()

/** Register a CEX adapter so it can be retrieved by name. */
export function registerCexAdapter(adapter: CexAdapter): void {
  _registry.set(adapter.name, adapter)
}

/** Retrieve a registered adapter by exchange name, or undefined if not found. */
export function getCexAdapter(name: string): CexAdapter | undefined {
  return _registry.get(name)
}

/** Return every registered adapter. */
export function getAllCexAdapters(): CexAdapter[] {
  return [..._registry.values()]
}

/**
 * Exchange names with a real adapter implementation. Everything else in
 * {@link createCexAdapter} is a typo, not an outage — and the difference
 * matters, because a silently-missing adapter reads as "the exchange has no
 * price today".
 */
export const KNOWN_CEX_EXCHANGES = ['coinbase'] as const

export type KnownCexExchange = (typeof KNOWN_CEX_EXCHANGES)[number]

/** Options accepted by {@link createCexAdapter} (currently only Coinbase's). */
export type CreateCexAdapterOptions = Partial<CoinbaseAdapterOptions>

/**
 * Build and register the adapter for an exchange, so callers stay
 * exchange-agnostic. This is the sanctioned entry point: an adapter that is
 * never registered is a venue nobody quotes.
 *
 * Returns the registered adapter, or undefined (with a loud log) for an
 * unknown exchange name — the registry is data-driven, and one bad name in a
 * configuration list must drop that venue, not crash the process that prices
 * every other one.
 */
export function createCexAdapter(exchange: string, options: CreateCexAdapterOptions = {}): CexAdapter | undefined {
  const key = String(exchange ?? '').trim().toLowerCase()
  let adapter: CexAdapter | undefined

  switch (key) {
    case 'coinbase':
      adapter = new CoinbaseCexAdapter(options)
      break
    default:
      console.warn(
        `[cex] Unknown exchange "${exchange}" — known adapters: ${KNOWN_CEX_EXCHANGES.join(', ')}. ` +
          `Registering nothing; this venue will simply have no price.`
      )
      return undefined
  }

  registerCexAdapter(adapter)
  return adapter
}

/** Re-exported here so registration code can import from one module only. */
export { CoinbaseCexAdapter } from './coinbase'
export type { CoinbaseAdapterOptions as CexAdapterOptions } from './coinbase'
