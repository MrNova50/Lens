import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  venueAdapters,
  sdexAdapter,
  ammAdapter,
  soroswapAdapter,
  aquariusAdapter,
  phoenixAdapter,
  startVenueAdapter,
  startAllVenueAdapters,
  writeVenuePricePoints,
  getLastPrice,
  resetLastPrice,
  setLastPrice,
  type VenueAdapter,
} from '../ingest/venues'

vi.mock('../db', () => ({
  upsertPricePoints: vi.fn().mockResolvedValue(1),
}))

vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../events', () => ({
  publishPriceUpdate: vi.fn(),
}))

describe('VenueAdapter Interface and Runner (#218)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLastPrice()
  })

  it('registers all existing venue adapters in venueAdapters registry', () => {
    expect(venueAdapters).toContain(sdexAdapter)
    expect(venueAdapters).toContain(ammAdapter)
    expect(venueAdapters).toContain(soroswapAdapter)
    expect(venueAdapters).toContain(aquariusAdapter)
    // Registration is what makes index.ts start one Phoenix instance per entry
    // in ENABLED_NETWORKS, each writing the network it read from — no runner
    // changes needed for a new venue.
    expect(venueAdapters).toContain(phoenixAdapter)
    expect(venueAdapters.length).toBe(5)
  })

  it('ensures each adapter implements the VenueAdapter contract', () => {
    for (const adapter of venueAdapters) {
      expect(typeof adapter.name).toBe('string')
      expect(typeof adapter.source).toBe('string')
      expect(typeof adapter.isEnabled).toBe('function')
      expect(typeof adapter.getPollIntervalMs).toBe('function')
      expect(typeof adapter.discover).toBe('function')
      expect(typeof adapter.read).toBe('function')
      expect(typeof adapter.derive).toBe('function')
      expect(typeof adapter.write).toBe('function')
      expect(typeof adapter.ingestPair).toBe('function')
    }
  })

  it('preserves exact source strings for backward compatibility', () => {
    expect(sdexAdapter.source).toBe('SDEX')
    expect(ammAdapter.source).toBe('AMM')
    expect(soroswapAdapter.source).toBe('soroswap_amm')
    expect(aquariusAdapter.source).toBe('aquarius_amm')
    expect(phoenixAdapter.source).toBe('phoenix_amm')
    expect(phoenixAdapter.name).toBe('Phoenix')
  })

  it('manages last-price tracking with network and pairKey isolation in runner', () => {
    const update1 = setLastPrice('SDEX', 'testnet', 'XLM-USD', 0.12)
    expect(update1.previousPrice).toBe(0.12)
    expect(update1.currentPrice).toBe(0.12)
    expect(getLastPrice('SDEX', 'testnet', 'XLM-USD')).toBe(0.12)
    expect(getLastPrice('SDEX', 'mainnet', 'XLM-USD')).toBeUndefined()

    const update2 = setLastPrice('SDEX', 'testnet', 'XLM-USD', 0.15)
    expect(update2.previousPrice).toBe(0.12)
    expect(update2.currentPrice).toBe(0.15)

    resetLastPrice('SDEX')
    expect(getLastPrice('SDEX', 'testnet', 'XLM-USD')).toBeUndefined()
  })

  it('supports adding a new venue adapter without modifying the runner', async () => {
    let cycleExecuted = false

    const customAdapter: VenueAdapter = {
      name: 'CustomDEX',
      source: 'custom_dex',
      isEnabled: () => false,
      getPollIntervalMs: () => 1000,
      discover: async () => [],
      read: async () => null,
      derive: () => [],
      write: async () => {},
      ingestPair: async () => {
        cycleExecuted = true
      },
    }

    await startVenueAdapter(customAdapter, 'testnet')
    expect(cycleExecuted).toBe(false)
  })
})
