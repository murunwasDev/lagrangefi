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
  /** Uncollected LP fees accrued in the position (raw token units) */
  tokensOwed0?: string
  tokensOwed1?: string
  /** Actual LP principal amounts in the position (raw token units, not fees) */
  amount0?: string
  amount1?: string
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
  /** Leftover tokens from the previous mint cycle that should be folded into this rebalance */
  pendingToken0?: string
  pendingToken1?: string
  /**
   * Token pair info — required when the position NFT no longer exists on-chain (recovery mode).
   * When provided and the tokenId is not found, rebalance skips the remove/collect/burn steps
   * and goes straight to swap + mint using the wallet balance.
   */
  token0?: string
  token1?: string
  fee?: number
}

export interface FeesCollected {
  amount0: string // raw token amount (e.g. "1500000" for 1.5 USDC)
  amount1: string
}

export interface SwapCost {
  amountIn:      string  // raw bigint string (tokenIn)
  amountOut:     string  // actual received (tokenOut)
  fairAmountOut: string  // at pre-swap spot price (tokenOut)
  direction:     'zeroForOne' | 'oneForZero'
}

export interface TxDetail {
  txHash: string
  action: string
  gasUsedWei: number
}

export interface RebalanceResult {
  success: boolean
  txHashes: string[]
  txDetails?: TxDetail[]
  /** Labels for each txHash entry (1:1 mapping) */
  txSteps?: string[]
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
  /** True when rebalance ran in recovery mode (position had no liquidity on entry) */
  isRecovery?: boolean
  /** Leftover tokens that did not fit into the new LP position — carry into the next rebalance */
  leftoverToken0?: string
  leftoverToken1?: string
  /** Swap cost (absent when no swap was needed) */
  swapCost?:    SwapCost
  /** Human-readable token1/token0 price before the swap (e.g. "2041.57000000") */
  priceAtSwap?: string
  /** Human-readable token1/token0 price after the swap (from Swap event sqrtPriceX96) */
  priceAtEnd?:  string
  /**
   * Present on failure when a collect ran before the failure (e.g. burn fee-cap error).
   * Total raw token amounts (principal + fees) recovered to the wallet.
   * The API must save these as pendingToken0/pendingToken1 so the next rebalance re-invests them.
   */
  recoveredToken0?: string
  recoveredToken1?: string
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
  txDetails?: TxDetail[]
  error?: string
  /** Total gas cost across all mint transactions, in wei */
  gasUsedWei?: string
  /** Actual amounts deposited into the LP position (from IncreaseLiquidity event) */
  amount0?: string
  amount1?: string
  /** Leftover tokens that did not fit into the LP position — carry into the first rebalance */
  leftoverToken0?: string
  leftoverToken1?: string
}

export interface CloseRequest {
  idempotencyKey: string
  tokenId: string
  /** Per-request wallet: private key (0x...) or BIP39 mnemonic phrase */
  walletPrivateKey?: string
  /** Leftover tokens from the last rebalance cycle — included in reported amounts and unwrapped */
  pendingToken0?: string
  pendingToken1?: string
}

export interface CloseResult {
  success: boolean
  txHashes: string[]
  txDetails?: TxDetail[]
  /** Labels for each txHash entry (1:1 mapping) */
  txSteps?: string[]
  /** Total token0 collected at close (principal + fees, raw units) */
  token0Amount?: string
  /** Total token1 collected at close (principal + fees, raw units) */
  token1Amount?: string
  /** LP fees only (total collected minus principal) — for accumulating into strategy stats */
  feesCollected?: FeesCollected
  /** Total gas cost across all close transactions, in wei */
  gasUsedWei?: string
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
