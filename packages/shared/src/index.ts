// Shared types between web/ and chain/ and api/

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
  /** Per-request wallet: private key (0x...) or BIP39 mnemonic phrase */
  walletPrivateKey?: string
}

export interface FeesCollected {
  amount0: string // raw token amount (e.g. "1500000" for 1.5 USDC)
  amount1: string
}

export interface RebalanceResult {
  success: boolean
  txHashes: string[]
  newTokenId?: string
  error?: string
  /** Fees collected during the collect step (from on-chain Collect event) */
  feesCollected?: FeesCollected
  /** Total gas cost across all transactions, in wei */
  gasUsedWei?: string
  /** Raw token amounts retrieved from old position (liquidity + fees) before rebalance */
  positionToken0Start?: string
  positionToken1Start?: string
  /** Raw token amounts deposited into new position after rebalance */
  positionToken0End?: string
  positionToken1End?: string
}

export interface MintRequest {
  ethAmount: string      // human-readable ETH to wrap → WETH, e.g. "0.05"
  usdcAmount: string     // human-readable USDC to deposit, e.g. "200"
  feeTier: number        // 100 | 500 | 3000 | 10000
  tickLower: number
  tickUpper: number
  slippageTolerance: number
  /** Per-request wallet: private key (0x...) or BIP39 mnemonic phrase */
  walletPrivateKey?: string
}

export interface MintResult {
  success: boolean
  tokenId?: string
  txHashes: string[]
  error?: string
  /** Total gas cost across all mint transactions, in wei */
  gasUsedWei?: string
}

export interface CloseRequest {
  idempotencyKey: string
  tokenId: string
  /** Per-request wallet: private key (0x...) or BIP39 mnemonic phrase */
  walletPrivateKey?: string
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

// --- User / Auth ---

export interface User {
  id: number
  username: string
  hasWallet: boolean
  createdAt: string
}

// --- Strategy ---

export type StrategyStatus = 'active' | 'paused' | 'stopped'

export interface Strategy {
  id: number
  userId: number
  name: string
  currentTokenId: string
  token0: string
  token1: string
  fee: number
  rangePercent: number
  slippageTolerance: number
  pollIntervalSeconds: number
  status: StrategyStatus
  createdAt: string
  stoppedAt: string | null
}

export interface CreateStrategyRequest {
  name: string
  tokenId: string
  rangePercent?: number       // default 0.05 (5%)
  slippageTolerance?: number  // default 0.005 (0.5%)
  pollIntervalSeconds?: number // default 60
}

// --- Strategy Stats ---

export interface StrategyStats {
  strategyId: number
  totalRebalances: number
  /** Raw token amounts as decimal strings */
  feesCollectedToken0: string
  feesCollectedToken1: string
  /** Total gas cost across all rebalances, in wei */
  gasCostWei: string
  /** Tick-based time-in-range tracking */
  totalPollTicks: number
  inRangeTicks: number
  timeInRangePct: number
  /** Computed metrics */
  avgRebalanceIntervalHours: number | null
  updatedAt: string
}

export interface RebalanceEventDto {
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
  errorMessage: string | null
  triggeredAt: string
  completedAt: string | null
}
