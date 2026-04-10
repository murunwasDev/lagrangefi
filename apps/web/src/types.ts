export interface Position {
  tokenId: string
  owner: string
  token0: string
  token1: string
  fee: number
  tickLower: number
  tickUpper: number
  liquidity: string
  tokensOwed0?: string
  tokensOwed1?: string
  amount0?: string   // actual token amount in LP (not fees) — needs API support
  amount1?: string
}

export interface PoolState {
  sqrtPriceX96: string
  tick: number
  price: string
  decimals0: number
  decimals1: number
}

export type StrategyStatus = 'INITIATING' | 'ACTIVE' | 'STOPPED_MANUALLY' | 'STOPPED_ON_ERROR'

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
  stopReason: string | null
  initialToken0Amount: string | null
  initialToken1Amount: string | null
  initialValueUsd: number | null
  openEthPriceUsd: number | null
  endToken0Amount: string | null
  endToken1Amount: string | null
  endValueUsd: number | null
  endEthPriceUsd: number | null
  pendingToken0: string
  pendingToken1: string
}

export interface StrategyStats {
  strategyId: number
  totalRebalances: number
  feesCollectedToken0: string
  feesCollectedToken1: string
  gasCostWei: number
  gasCostUsd: number
  feesCollectedUsd: number
  totalPollTicks: number
  inRangeTicks: number
  timeInRangePct: number
  avgRebalanceIntervalHours: number | null
  updatedAt: string
  // Swap cost tracking (new — may be absent on old records)
  swapCostToken0?: string
  swapCostToken1?: string
  swapCostUsd?: number
  avgPriceDriftPct?: number
  currentRebalancingDragUsd?: number | null
}

export interface ChainTransaction {
  id: number
  txHash: string
  action: string
  gasUsedWei: number
}

export interface RebalanceDetails {
  oldNftTokenId: string | null
  newNftTokenId: string | null
  newTickLower: number | null
  newTickUpper: number | null
  feesCollectedToken0: string | null
  feesCollectedToken1: string | null
  gasUsedWei: number | null
  ethPriceUsd: number | null
  positionToken0Start: string | null
  positionToken1Start: string | null
  positionToken0End: string | null
  positionToken1End: string | null
  // Swap cost (null when no swap was needed)
  swapCostAmountIn: string | null
  swapCostAmountOut: string | null
  swapCostFairAmountOut: string | null
  swapCostDirection: 'zeroForOne' | 'oneForZero' | null
  swapCostUsd: number | null
  // Price drift P&L
  priceAtDecision: number | null
  priceAtEnd: number | null
  priceDriftPct: number | null
  priceDriftUsd: number | null
  // Rebalancing drag
  rebalancingDragUsd: number | null
  hodlValueUsd: number | null
}

export interface StrategyEvent {
  id: number
  strategyId: number
  action: string    // "REBALANCE" | "START_STRATEGY" | "CLOSE_STRATEGY"
  status: 'pending' | 'success' | 'failed'
  idempotencyKey: string
  errorMessage: string | null
  triggeredAt: string
  completedAt: string | null
  rebalanceDetails: RebalanceDetails | null
  transactions: ChainTransaction[]
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
