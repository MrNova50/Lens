import 'dotenv/config'
import { Networks, StrKey } from '@stellar/stellar-sdk'
import type { WatchedPair, AssetId } from './types'

// ── Types ─────────────────────────────────────────────────────────────────────

export type NetworkName = 'testnet' | 'mainnet'

/**
 * Maps one watched-pair asset to the Soroban token contract Phoenix trades it as.
 *
 * Phoenix pools are made of SAC token contracts, but a watched pair names its
 * assets the classic way (`CODE:ISSUER`). `key` is that classic identifier —
 * `"XLM"` for the native asset, `"CODE:ISSUER"` for a credit asset — and
 * `tokenAddress` the contract id it resolves to. This repo ships only mappings
 * it can source (native XLM's deterministic SAC wrapper and mainnet Circle USDC);
 * every other token comes from `PHOENIX_TOKEN_ADDRESSES_<NETWORK>` so an unmapped
 * asset quotes no pool rather than a guessed one.
 */
export interface PhoenixTokenAddress {
  /** `"XLM"` (native) or `"CODE:ISSUER"`, matched case-insensitively by code. */
  key: string
  /** The Soroban SAC contract id this asset trades as on Phoenix. */
  tokenAddress: string
}

/** Per-network configuration block. */
export interface NetworkConfig {
  horizon: {
    url: string
  }
  rpc: {
    url: string
  }
  network: {
    passphrase: string
  }
  soroswap: {
    /** Whether Soroswap has a usable deployment on this network. */
    enabled: boolean
    /** Soroswap factory contract address for this network. */
    factoryAddress: string
    /** Soroswap token-list URL for this network. */
    tokenListUrl: string
    /** How often to poll Soroswap pool reserves in ms. */
    pollIntervalMs: number
  }
  aquarius: {
    /** Whether Aquarius has a usable deployment on this network. */
    enabled: boolean
    /** Aquarius AMM pools API base URL for this network. */
    apiUrl: string
  }
  phoenix: {
    /** Whether Phoenix has a usable deployment on this network. */
    enabled: boolean
    /** Phoenix factory contract id for this network. */
    factoryAddress: string
    /** How often to poll Phoenix pool reserves in ms. */
    pollIntervalMs: number
    /** How long to cache the factory's pool list before re-discovery, in ms. */
    discoveryTtlMs: number
    /** Asset-code → SAC-contract mappings used to match watched pairs to pools. */
    tokenAddresses: PhoenixTokenAddress[]
  }
  oracle: {
    /** Whether the Reflector oracle is deployed on this network. */
    enabled: boolean
    /** Reflector oracle contract ID for this network. */
    reflectorContractId: string
  }
  /** Watched asset pairs for this network. */
  pairs: WatchedPair[]
  facilitator: {
    /** Secret key for the facilitator's fee-paying account */
    secretKey?: string
    /** Maximum fee in stroops the facilitator will pay */
    feeStroops: number
  }
}

// ── Asset / pair parsing ───────────────────────────────────────────────────────

function parseAsset(str: string): AssetId {
  const [code, issuer] = str.split(':')
  return {
    code: code.toUpperCase(),
    issuer: (!issuer || issuer.toLowerCase() === 'native') ? null : issuer,
  }
}

function makePairKey(a: AssetId, b: AssetId): string {
  const aStr = a.issuer ? `${a.code}:${a.issuer}` : a.code
  const bStr = b.issuer ? `${b.code}:${b.issuer}` : b.code
  // Alphabetical sort so XLM/USDC and USDC/XLM resolve to the same key
  return [aStr, bStr].sort().join('/')
}

const MAINNET_DEFAULT_PAIRS =
  'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM'

function parseWatchedPairs(raw: string): WatchedPair[] {
  if (!raw.trim()) return []
  return raw.split(',').map(pair => {
    const [a, b] = pair.trim().split('/')
    if (!a || !b) {
      throw new Error(
        `Invalid pair format: "${pair}". Expected "CODE:ISSUER/CODE:ISSUER"`
      )
    }
    const assetA = parseAsset(a)
    const assetB = parseAsset(b)
    return { assetA, assetB, pairKey: makePairKey(assetA, assetB) }
  })
}

// ── Phoenix token-address map ─────────────────────────────────────────────────

/**
 * Parse `PHOENIX_TOKEN_ADDRESSES[_NETWORK]`, a JSON array of
 * `{ "key": "CODE[:ISSUER]", "tokenAddress": "C..." }` entries telling the
 * adapter which SAC contract each watched asset trades as on Phoenix.
 *
 * Never throws: an unparseable or empty value leaves the venue with only its
 * built-in mappings. An entry is dropped (with a warning naming the env var)
 * when it lacks a key or its contract id is not a well-formed Soroban address —
 * an entry that resolves to a bad id would aim the venue at someone else's
 * contract under a real-looking source label.
 */
function parsePhoenixTokenAddresses(
  raw: string,
  envVar: string,
  builtIn: PhoenixTokenAddress[]
): PhoenixTokenAddress[] {
  // Built-in mappings always apply; operator entries layer on top and win on key.
  const byKey = new Map<string, PhoenixTokenAddress>()
  for (const entry of builtIn) byKey.set(entry.key.toUpperCase(), entry)

  if (!raw || !raw.trim()) return [...byKey.values()]

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(
      `[config] ${envVar} is not valid JSON (expected an array of {key,tokenAddress}); using built-in mappings: ${(err as Error).message}`
    )
    return [...byKey.values()]
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[config] ${envVar} must be a JSON array of {key,tokenAddress}; using built-in mappings`)
    return [...byKey.values()]
  }

  for (const [i, entry] of parsed.entries()) {
    if (!entry || typeof entry !== 'object') {
      console.warn(`[config] ${envVar}[${i}] is not an object; skipped`)
      continue
    }
    const e = entry as Record<string, unknown>
    const key = typeof e.key === 'string' ? e.key.trim() : ''
    const tokenAddress = typeof e.tokenAddress === 'string' ? e.tokenAddress.trim() : ''
    if (!key) {
      console.warn(`[config] ${envVar}[${i}] needs a "key" (e.g. "XLM" or "USDC:G..."); skipped`)
      continue
    }
    if (!isUsableContractId(tokenAddress, `${envVar}[${i}].tokenAddress`)) continue
    byKey.set(key.toUpperCase(), { key, tokenAddress })
  }
  return [...byKey.values()]
}

// ── Per-network config builder ────────────────────────────────────────────────

/**
 * Build a NetworkConfig for the given network name.
 *
 * Resolution order for each field (first value that is non-empty wins):
 *   1. Paired env var  — e.g. HORIZON_URL_TESTNET / HORIZON_URL_MAINNET
 *   2. Generic env var — e.g. HORIZON_URL   (back-compat with single-network setups)
 *   3. Sensible default for that network
 */
/**
 * True when `id` is a well-formed Soroban contract id (`C...`, 56 chars,
 * valid checksum). A malformed id otherwise surfaces later as an opaque decode
 * error on every RPC call, so config refuses to hand one out: on failure it
 * warns, naming the env var, and the caller disables the feature that needs it.
 */
function isUsableContractId(id: string, envVar: string): boolean {
  if (id === '') return false
  if (StrKey.isValidContract(id)) return true
  console.warn(
    `[config] ${envVar}="${id}" is not a valid Soroban contract id (expected a 56-character C... address); the feature that needs it is disabled`
  )
  return false
}

function buildNetworkConfig(network: NetworkName): NetworkConfig {
  const suffix = network.toUpperCase() as 'TESTNET' | 'MAINNET'

  // ── Horizon ──────────────────────────────────────────────────────────────
  const horizonUrl =
    process.env[`HORIZON_URL_${suffix}`] ||
    (network === 'testnet' ? process.env.HORIZON_URL : undefined) ||
    (network === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org')

  // ── Soroban RPC ───────────────────────────────────────────────────────────
  const rpcUrl =
    process.env[`RPC_URL_${suffix}`] ||
    (network === 'testnet' ? process.env.RPC_URL : undefined) ||
    (network === 'mainnet'
      ? 'https://mainnet.sorobanrpc.com'
      : 'https://soroban-testnet.stellar.org')

  // ── Network passphrase ────────────────────────────────────────────────────
  const passphrase =
    process.env[`NETWORK_PASSPHRASE_${suffix}`] ||
    (network === 'testnet' ? process.env.NETWORK_PASSPHRASE : undefined) ||
    (network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET)

  // ── Soroswap factory ──────────────────────────────────────────────────────
  const soroswapFactory =
    process.env[`SOROSWAP_FACTORY_ADDRESS_${suffix}`] ||
    process.env.SOROSWAP_FACTORY_ADDRESS ||
    (network === 'mainnet'
      ? 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2'
      : 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY')

  // Soroswap token-list is a single canonical list covering both networks by
  // default, but can be overridden per network (e.g. a testnet-specific list).
  const soroswapTokenListUrl =
    process.env[`SOROSWAP_TOKEN_LIST_URL_${suffix}`] ||
    process.env.SOROSWAP_TOKEN_LIST_URL ||
    'https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json'

  const soroswapEnabled =
    (process.env[`SOROSWAP_ENABLED_${suffix}`] ?? 'true').toLowerCase() !== 'false' &&
    isUsableContractId(soroswapFactory, `SOROSWAP_FACTORY_ADDRESS_${suffix}`)

  const soroswapPollMs = parseInt(
    process.env[`SOROSWAP_POLL_INTERVAL_MS_${suffix}`] ||
    process.env.SOROSWAP_POLL_INTERVAL_MS ||
    '60000',
    10
  )

  // ── Aquarius ──────────────────────────────────────────────────────────────
  // Aquarius only runs on Stellar classic mainnet today — there is no public
  // testnet deployment, so it is disabled there by default.
  const aquariusApiUrl =
    process.env[`AQUARIUS_API_URL_${suffix}`] ||
    process.env.AQUARIUS_API_URL ||
    'https://amm.aquarius.network/api/v1/pools/'

  const aquariusEnabled =
    (process.env[`AQUARIUS_ENABLED_${suffix}`] ?? (network === 'mainnet' ? 'true' : 'false')).toLowerCase() !== 'false'

  // ── Phoenix ───────────────────────────────────────────────────────────────
  // Phoenix's documented factory deployments, written in full from Phoenix's own
  // integrations material (and cross-checked against a working aggregator's pool
  // discovery). Both networks carry a real deployment, so — unlike the oracle —
  // there is an address to paste here rather than a hole to leave.
  const phoenixFactory =
    process.env[`PHOENIX_FACTORY_ADDRESS_${suffix}`] ||
    process.env.PHOENIX_FACTORY_ADDRESS ||
    (network === 'mainnet'
      ? 'CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI'
      : 'CBIFTP5CLUIVIVJ7WAMGOQPYPCV3CH3AVMHNWIL5XDPYCRWLBPUWL7FI')

  // Native XLM's SAC wrapper is derived from the network id + "lmex" mnemonic, so
  // the same contract id names native XLM on both networks. Mainnet Circle USDC's
  // SAC contract is CCW67… (the issuer GA5ZSEJY… is the pair the wallet trades,
  // confirmed by the repo's own mainnet default pair). Testnet ships no USDC
  // mapping: no verifiable contract id was found, so a testnet USDC pool stays
  // unquoted until an operator names it — never guessed.
  const phoenixBuiltInTokens: PhoenixTokenAddress[] = [
    { key: 'XLM', tokenAddress: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA' },
    ...(network === 'mainnet'
      ? [
          {
            key: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            tokenAddress: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
          },
        ]
      : []),
  ]

  const phoenixTokenRaw =
    process.env[`PHOENIX_TOKEN_ADDRESSES_${suffix}`] ||
    (network === 'testnet' ? process.env.PHOENIX_TOKEN_ADDRESSES : undefined) ||
    ''

  const phoenixTokenAddresses = parsePhoenixTokenAddresses(
    phoenixTokenRaw,
    `PHOENIX_TOKEN_ADDRESSES_${suffix}`,
    phoenixBuiltInTokens
  )

  const phoenixEnabled =
    (process.env[`PHOENIX_ENABLED_${suffix}`] ?? 'true').toLowerCase() !== 'false' &&
    isUsableContractId(phoenixFactory, `PHOENIX_FACTORY_ADDRESS_${suffix}`)

  const phoenixPollMs = parseInt(
    process.env[`PHOENIX_POLL_INTERVAL_MS_${suffix}`] ||
    process.env.PHOENIX_POLL_INTERVAL_MS ||
    '60000',
    10
  )

  const phoenixDiscoveryTtlMs = parseInt(
    process.env[`PHOENIX_DISCOVERY_TTL_MS_${suffix}`] ||
    process.env.PHOENIX_DISCOVERY_TTL_MS ||
    '300000',
    10
  )

  // ── Reflector oracle ──────────────────────────────────────────────────────
  // No built-in default: the previous mainnet literal was a malformed
  // (55-character) id and a replacement could not be verified against
  // Reflector's published deployments. Set REFLECTOR_CONTRACT_ID_<NETWORK> to
  // the oracle contract listed at https://reflector.network to enable it.
  const reflectorContractId =
    process.env[`REFLECTOR_CONTRACT_ID_${suffix}`] ||
    process.env.REFLECTOR_CONTRACT_ID ||
    ''

  const oracleEnabled =
    (process.env[`REFLECTOR_ENABLED_${suffix}`] ?? 'true').toLowerCase() !== 'false' &&
    isUsableContractId(reflectorContractId, `REFLECTOR_CONTRACT_ID_${suffix}`)

  // ── Watched pairs ─────────────────────────────────────────────────────────
  // Mainnet gets a default for the same reason every field above does: turning
  // it on should not require knowing an issuer address by heart. USDC/XLM is
  // the pair the wallet actually converts balances against.
  //
  // The issuer is Circle's, confirmed by its home domain (circle.com) rather
  // than by asset code — Horizon lists many unrelated assets also called USDC,
  // and picking the wrong one would quote a price no one trades at.
  const rawPairs =
    process.env[`WATCHED_PAIRS_${suffix}`] ||
    (network === 'testnet' ? process.env.WATCHED_PAIRS : undefined) ||
    (network === 'mainnet' ? MAINNET_DEFAULT_PAIRS : '')

  // ── Facilitator ───────────────────────────────────────────────────────────
  const facilitatorSecretKey =
    process.env[`FACILITATOR_SECRET_KEY_${suffix}`] ||
    (network === 'testnet' ? process.env.FACILITATOR_SECRET_KEY : undefined)

  const facilitatorFeeStroops = parseInt(
    process.env[`FACILITATOR_FEE_STROOPS_${suffix}`] ||
    process.env.FACILITATOR_FEE_STROOPS ||
    '50000',
    10
  )

  return {
    horizon: { url: horizonUrl },
    rpc: { url: rpcUrl },
    network: { passphrase },
    soroswap: {
      enabled: soroswapEnabled,
      factoryAddress: soroswapFactory,
      tokenListUrl: soroswapTokenListUrl,
      pollIntervalMs: soroswapPollMs,
    },
    aquarius: {
      enabled: aquariusEnabled,
      apiUrl: aquariusApiUrl,
    },
    phoenix: {
      enabled: phoenixEnabled,
      factoryAddress: phoenixFactory,
      pollIntervalMs: phoenixPollMs,
      discoveryTtlMs: phoenixDiscoveryTtlMs,
      tokenAddresses: phoenixTokenAddresses,
    },
    oracle: { enabled: oracleEnabled, reflectorContractId },
    pairs: parseWatchedPairs(rawPairs),
    facilitator: { secretKey: facilitatorSecretKey, feeStroops: facilitatorFeeStroops },
  }
}

// ── Global (non-network-specific) config ──────────────────────────────────────

const globalConfig = {
  db: {
    url: process.env.DATABASE_URL ?? 'postgresql://lens:lens@localhost:5432/lens',
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  api: {
    port: parseInt(process.env.PORT ?? '3002', 10),
    host: process.env.HOST ?? '0.0.0.0',
  },
  indexer: {
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10),
    sdexPageSize: parseInt(process.env.SDEX_PAGE_SIZE ?? '200', 10),
    ammPageSize: parseInt(process.env.AMM_PAGE_SIZE ?? '200', 10),
  },
  cache: {
    priceTtl: parseInt(process.env.PRICE_CACHE_TTL ?? '10', 10),
  },
} as const

// ── Per-network map ───────────────────────────────────────────────────────────

/**
 * `config.networks` holds a fully-resolved config block for each Stellar
 * network.  Each block is built lazily on first access so startup cost stays
 * minimal when only one network is active.
 */
const _networkCache = new Map<NetworkName, NetworkConfig>()

function resolveNetwork(name: NetworkName): NetworkConfig {
  const cached = _networkCache.get(name)
  if (cached) return cached
  const built = buildNetworkConfig(name)
  _networkCache.set(name, built)
  return built
}

/**
 * Return the fully-resolved config for a given network.
 *
 * @example
 * const { horizon, rpc, soroswap } = getNetworkConfig('mainnet')
 */
export function getNetworkConfig(network: NetworkName): NetworkConfig {
  return resolveNetwork(network)
}

// ── Active network ────────────────────────────────────────────────────────────

/**
 * The active network, driven by the `STELLAR_NETWORK` env var.
 * Falls back to `'testnet'` when unset so local dev always works.
 */
export const activeNetwork: NetworkName =
  (process.env.STELLAR_NETWORK?.toLowerCase() as NetworkName | undefined) === 'mainnet'
    ? 'mainnet'
    : 'testnet'

// ── Unified config export ─────────────────────────────────────────────────────

/**
 * The main config export consumed throughout the app.
 *
 * - `config.networks.testnet` / `config.networks.mainnet` — per-network blocks
 * - `config.network`  — shorthand for the currently-active network block
 *                       (driven by `STELLAR_NETWORK` env var; defaults to testnet)
 * - All other top-level keys (`db`, `redis`, `api`, `indexer`, `cache`) are
 *   network-agnostic and shared across both networks.
 *
 * Back-compat: any existing code that reads `config.horizon.url`,
 * `config.rpc.url`, `config.network.passphrase`, `config.soroswap.*`, or
 * `config.pairs` continues to work — those paths now proxy to the active
 * network's block.
 */
export const config = {
  // ── Network map ────────────────────────────────────────────────────────────
  networks: {
    get testnet(): NetworkConfig { return resolveNetwork('testnet') },
    get mainnet(): NetworkConfig { return resolveNetwork('mainnet') },
  },

  // ── Active-network shortcuts (back-compat) ─────────────────────────────────
  get horizon()  { return resolveNetwork(activeNetwork).horizon },
  get rpc()      { return resolveNetwork(activeNetwork).rpc },
  get network()  { return resolveNetwork(activeNetwork).network },
  get soroswap() { return resolveNetwork(activeNetwork).soroswap },
  get aquarius() { return resolveNetwork(activeNetwork).aquarius },
  get phoenix() { return resolveNetwork(activeNetwork).phoenix },
  get oracle()   { return resolveNetwork(activeNetwork).oracle },
  get pairs()    { return resolveNetwork(activeNetwork).pairs },
  get facilitator() { return resolveNetwork(activeNetwork).facilitator },

  // ── Global / network-agnostic ──────────────────────────────────────────────
  db:      globalConfig.db,
  redis:   globalConfig.redis,
  api:     globalConfig.api,
  indexer: globalConfig.indexer,
  cache:   globalConfig.cache,
}
