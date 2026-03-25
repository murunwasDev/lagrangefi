// Shared types between web/ and chain/

export interface Position {
  tokenId: string
  owner: string
  token0: string
  token1: string
  fee: number
  tickLower: number
  tickUpper: number
  liquidity: string
}

export interface PoolState {
  sqrtPriceX96: string
  tick: number
  price: string // human-readable price token1/token0
  decimals0: number
  decimals1: number
}

export interface RebalanceRequest {
  idempotencyKey: string
  tokenId: string
  newTickLower: number
  newTickUpper: number
  slippageTolerance: number // e.g. 0.005 = 0.5%
}

export interface RebalanceResult {
  success: boolean
  txHashes: string[]
  newTokenId?: string
  error?: string
}

export interface MintRequest {
  ethAmount: string      // human-readable ETH to wrap → WETH, e.g. "0.05"
  usdcAmount: string     // human-readable USDC to deposit, e.g. "200"
  feeTier: number        // 100 | 500 | 3000 | 10000
  tickLower: number
  tickUpper: number
  slippageTolerance: number
}

export interface MintResult {
  success: boolean
  tokenId?: string
  txHashes: string[]
  error?: string
}

export interface CloseRequest {
  idempotencyKey: string
  tokenId: string
}

export interface CloseResult {
  success: boolean
  txHashes: string[]
  error?: string
}

export interface ExecuteStep {
  type: 'remove_liquidity' | 'collect_fees' | 'swap' | 'add_liquidity'
  params: Record<string, unknown>
}

export interface ExecuteRequest {
  idempotencyKey: string
  steps: ExecuteStep[]
}
