export const AUTH = {
  MAX_PUBLIC_KEY_CACHE_SIZE: 1000,
} as const

export const EMBEDDING = {
  CHUNK_SIZE: 32,
} as const

export const PAYMENT = {
  PRECISION_DECIMALS: 18,
  MAX_SAFE_CONTRIBUTION: Number.MAX_SAFE_INTEGER / 1e9,
  INVOICE_EXPIRATION_GRACE_MS: 60000,
} as const

export const WALLET = {
  MAX_ETH_AMOUNT: 1e15,
} as const
