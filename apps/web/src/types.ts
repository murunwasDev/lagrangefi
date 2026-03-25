export interface Position {
  tokenId: string
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
  price: string
  decimals0: number
  decimals1: number
}

export interface RebalanceEvent {
  id: number
  tokenId: string
  status: 'pending' | 'success' | 'failed'
  newTickLower: number | null
  newTickUpper: number | null
  newTokenId: string | null
  txHashes: string | null
  errorMessage: string | null
  triggeredAt: string
  completedAt: string | null
}

export interface StartStrategyRequest {
  ethAmount: string
  usdcAmount: string
  feeTier: number
  rangePercent: number
}

export interface StartStrategyResult {
  success: boolean
  tokenId?: string
  txHashes?: string[]
  error?: string
}

export interface CloseResult {
  success: boolean
  txHashes?: string[]
  error?: string
}

export interface WalletBalances {
  address: string
  eth: string
  usdc: string
}
