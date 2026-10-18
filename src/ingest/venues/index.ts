import { sdexAdapter } from './sdex'
import { ammAdapter } from './amm'
import { soroswapAdapter } from './soroswap'
import { aquariusAdapter } from './aquarius'
import { phoenixAdapter } from './phoenix'
import type { VenueAdapter } from './types'

export * from './types'
export * from './runner'
export { sdexAdapter, startSDEXIngester } from './sdex'
export { ammAdapter, startAMMIngester } from './amm'
export { soroswapAdapter, startSoroswapIngester } from './soroswap'
export { aquariusAdapter, startAquariusIngester } from './aquarius'
export { phoenixAdapter, startPhoenixIngester } from './phoenix'

/**
 * Registry of all available venue adapters.
 * Adding a venue to this list enables it across the venue runner automatically
 * without requiring runner code modifications.
 */
export const venueAdapters: VenueAdapter[] = [
  sdexAdapter,
  ammAdapter,
  soroswapAdapter,
  aquariusAdapter,
  phoenixAdapter,
]
