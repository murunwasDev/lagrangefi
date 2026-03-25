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

export interface ExecuteStep {
  type: 'remove_liquidity' | 'collect_fees' | 'swap' | 'add_liquidity'
  params: Record<string, unknown>
}

export interface ExecuteRequest {
  idempotencyKey: string
  steps: ExecuteStep[]
}
