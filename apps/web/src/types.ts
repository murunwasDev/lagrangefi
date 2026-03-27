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
  price: string
  decimals0: number
  decimals1: number
}

export type StrategyStatus = 'active' | 'stopped'

export interface Strategy {
  id: number
  userId: number
  name: string
  currentTokenId: string
  token0: string
  token1: string
  fee: number
  token0Decimals: number
  token1Decimals: number
  rangePercent: number
  slippageTolerance: number
  pollIntervalSeconds: number
  status: StrategyStatus
  createdAt: string
  stoppedAt: string | null
  initialToken0Amount: string | null
  initialToken1Amount: string | null
  initialValueUsd: number | null
}

export interface StrategyStats {
  strategyId: number
  totalRebalances: number
  feesCollectedToken0: string
  feesCollectedToken1: string
  gasCostWei: string
  gasCostUsd: number
  feesCollectedUsd: number
  closeEthPriceUsd: number | null
  closeFeesUsd: number | null
  closeGasUsd: number | null
  totalPollTicks: number
  inRangeTicks: number
  timeInRangePct: number
  avgRebalanceIntervalHours: number | null
  updatedAt: string
}

export interface RebalanceEvent {
  id: number
  strategyId: number
  tokenId: string
  status: 'pending' | 'success' | 'failed'
  newTickLower: number | null
  newTickUpper: number | null
  newTokenId: string | null
  txHashes: string | null
  feesCollectedToken0: string | null
  feesCollectedToken1: string | null
  gasCostWei: string | null
  positionToken0Start: string | null
  positionToken1Start: string | null
  positionToken0End: string | null
  positionToken1End: string | null
  ethPriceUsd: string | null
  errorMessage: string | null
  triggeredAt: string
  completedAt: string | null
}

export interface User {
  userId: number
  username: string
  hasWallet: boolean
}

export interface CreateStrategyRequest {
  name: string
  tokenId: string
  rangePercent: number
  slippageTolerance: number
  pollIntervalSeconds: number
}
