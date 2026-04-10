import type { Strategy, StrategyStats, StrategyEvent, Position, PoolState } from './types'

// true in Vite dev server, false in production builds
export const MOCK_MODE = import.meta.env.DEV

// ── Auth ─────────────────────────────────────────────────────────────────────

export const MOCK_USER = { userId: 1, username: 'demo', hasWallet: true }
export const MOCK_TOKEN = 'mock-jwt-token'

// ── Strategy ─────────────────────────────────────────────────────────────────

export const MOCK_STRATEGIES: Strategy[] = [
  {
    id: 1,
    userId: 1,
    name: 'ETH/USDC 0.05%',
    currentTokenId: '812045',
    token0: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    token1: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
    fee: 500,
    token0Decimals: 6,
    token1Decimals: 18,
    rangePercent: 0.05,
    slippageTolerance: 0.005,
    pollIntervalSeconds: 60,
    status: 'ACTIVE',
    createdAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    stoppedAt: null,
    stopReason: null,
    initialToken0Amount: '850000000',        // 850 USDC
    initialToken1Amount: '415000000000000000', // 0.415 WETH
    initialValueUsd: 1696.15,
    openEthPriceUsd: 2051.00,
    endToken0Amount: null,
    endToken1Amount: null,
    endValueUsd: null,
    endEthPriceUsd: null,
    pendingToken0: '120000',    // 0.12 USDC dust
    pendingToken1: '0',
  },
]

// ── Stats ─────────────────────────────────────────────────────────────────────

export const MOCK_STATS: Record<number, StrategyStats> = {
  1: {
    strategyId: 1,
    totalRebalances: 3,
    feesCollectedToken0: '4210000',         // 4.21 USDC
    feesCollectedToken1: '2100000000000000', // 0.0021 WETH
    gasCostWei: 4_024_000_000_000_000,      // rebalances (2.85M) + open mint (1.174M)
    gasCostUsd: 8.22,
    feesCollectedUsd: 8.52,
    totalPollTicks: 420,
    inRangeTicks: 378,
    timeInRangePct: 90.0,
    avgRebalanceIntervalHours: 55.2,
    updatedAt: new Date().toISOString(),
    swapCostToken0: '0',
    swapCostToken1: '3210000000000000',     // 0.00321 WETH total swap cost
    swapCostUsd: 6.57,
    avgPriceDriftPct: -0.38,
  },
}

// ── Position ──────────────────────────────────────────────────────────────────

export const MOCK_POSITION: Position = {
  tokenId: '812045',
  owner: '0xdeadbeefdeadbeefdeadbeefdeadbeef00000001',
  token0: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  token1: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  fee: 500,
  tickLower: -200820,
  tickUpper: -199820,
  liquidity: '8420000000000000',
  tokensOwed0: '1240000',         // 1.24 USDC unclaimed
  tokensOwed1: '520000000000000', // 0.00052 WETH unclaimed
  amount0: '742000000',           // 742 USDC in LP
  amount1: '362000000000000000',  // 0.362 WETH in LP
}

// ── Pool state ────────────────────────────────────────────────────────────────

export const MOCK_POOL_STATE: PoolState = {
  sqrtPriceX96: '3961408125713216879677197516800',
  tick: -200312,
  price: '2032.85',
  decimals0: 6,
  decimals1: 18,
}

// ── Rebalance events ──────────────────────────────────────────────────────────

const now = Date.now()

export const MOCK_REBALANCES: Record<number, StrategyEvent[]> = {
  1: [
    // Rebalance #3 — most recent, successful
    {
      id: 103,
      strategyId: 1,
      action: 'REBALANCE',
      status: 'success',
      idempotencyKey: 'idem-103',
      errorMessage: null,
      triggeredAt: new Date(now - 18 * 3_600_000).toISOString(),
      completedAt: new Date(now - 18 * 3_600_000 + 42_000).toISOString(),
      rebalanceDetails: {
        oldNftTokenId: '811990',
        newNftTokenId: '812045',
        newTickLower: -200820,
        newTickUpper: -199820,
        feesCollectedToken0: '1850000',         // 1.85 USDC
        feesCollectedToken1: '920000000000000',  // 0.00092 WETH
        gasUsedWei: 980_000_000_000_000,
        ethPriceUsd: 2041.57,
        positionToken0Start: '860000000',        // 860 USDC (principal + fees)
        positionToken1Start: '421000000000000000',
        positionToken0End:   '742000000',
        positionToken1End:   '362000000000000000',
        // NEW: swap cost (sold WETH → USDC, oneForZero)
        swapCostAmountIn:       '58000000000000000',  // 0.058 WETH in
        swapCostAmountOut:      '117720000',           // 117.72 USDC out
        swapCostFairAmountOut:  '118362000',           // 118.36 USDC fair
        swapCostDirection:      'oneForZero',
        swapCostUsd:            0.64,
        // NEW: price drift
        priceAtDecision: 2041.57,
        priceAtEnd:      2032.85,
        priceDriftPct:   -0.43,
        priceDriftUsd:   -3.11,
        rebalancingDragUsd:           1.24,
        hodlValueUsd:    21.16,
      },
      transactions: [
        { id: 1, txHash: '0xabc1230000000000000000000000000000000000000000000000000000000001', action: 'COLLECT_FEES', gasUsedWei: 320_000_000_000_000 },
        { id: 2, txHash: '0xabc1230000000000000000000000000000000000000000000000000000000002', action: 'BURN',          gasUsedWei: 120_000_000_000_000 },
        { id: 3, txHash: '0xabc1230000000000000000000000000000000000000000000000000000000003', action: 'SWAP',          gasUsedWei: 380_000_000_000_000 },
        { id: 4, txHash: '0xabc1230000000000000000000000000000000000000000000000000000000004', action: 'MINT',          gasUsedWei: 160_000_000_000_000 },
      ],
    },

    // Rebalance #2 — price drifted UP (profit on drift)
    {
      id: 102,
      strategyId: 1,
      action: 'REBALANCE',
      status: 'success',
      idempotencyKey: 'idem-102',
      errorMessage: null,
      triggeredAt: new Date(now - 72 * 3_600_000).toISOString(),
      completedAt: new Date(now - 72 * 3_600_000 + 38_000).toISOString(),
      rebalanceDetails: {
        oldNftTokenId: '811931',
        newNftTokenId: '811990',
        newTickLower: -201020,
        newTickUpper: -200020,
        feesCollectedToken0: '1420000',
        feesCollectedToken1: '680000000000000',
        gasUsedWei: 950_000_000_000_000,
        ethPriceUsd: 1987.30,
        positionToken0Start: '820000000',
        positionToken1Start: '412000000000000000',
        positionToken0End:   '715000000',
        positionToken1End:   '350000000000000000',
        swapCostAmountIn:       '62000000000000000',
        swapCostAmountOut:      '122580000',
        swapCostFairAmountOut:  '123100000',
        swapCostDirection:      'oneForZero',
        swapCostUsd:            0.52,
        priceAtDecision: 1987.30,
        priceAtEnd:      1995.80,
        priceDriftPct:   0.43,
        priceDriftUsd:   3.40,
        rebalancingDragUsd:           0.87,
        hodlValueUsd:    20.45,
      },
      transactions: [
        { id: 5, txHash: '0xbbb1230000000000000000000000000000000000000000000000000000000001', action: 'COLLECT_FEES', gasUsedWei: 310_000_000_000_000 },
        { id: 6, txHash: '0xbbb1230000000000000000000000000000000000000000000000000000000002', action: 'BURN',          gasUsedWei: 118_000_000_000_000 },
        { id: 7, txHash: '0xbbb1230000000000000000000000000000000000000000000000000000000003', action: 'SWAP',          gasUsedWei: 362_000_000_000_000 },
        { id: 8, txHash: '0xbbb1230000000000000000000000000000000000000000000000000000000004', action: 'MINT',          gasUsedWei: 160_000_000_000_000 },
      ],
    },

    // Strategy open (mint)
    {
      id: 100,
      strategyId: 1,
      action: 'START_STRATEGY',
      status: 'success',
      idempotencyKey: 'idem-100',
      errorMessage: null,
      triggeredAt: new Date(now - 168 * 3_600_000).toISOString(),
      completedAt: new Date(now - 168 * 3_600_000 + 55_000).toISOString(),
      rebalanceDetails: null,
      transactions: [
        { id: 11, txHash: '0xddd1230000000000000000000000000000000000000000000000000000000001', action: 'WRAP',    gasUsedWei: 42_000_000_000_000  },
        { id: 12, txHash: '0xddd1230000000000000000000000000000000000000000000000000000000002', action: 'APPROVE', gasUsedWei: 46_000_000_000_000  },
        { id: 13, txHash: '0xddd1230000000000000000000000000000000000000000000000000000000003', action: 'APPROVE', gasUsedWei: 46_000_000_000_000  },
        { id: 14, txHash: '0xddd1230000000000000000000000000000000000000000000000000000000004', action: 'MINT',    gasUsedWei: 1_040_000_000_000_000 },
      ],
    },

    // Rebalance #1 — failed
    {
      id: 101,
      strategyId: 1,
      action: 'REBALANCE',
      status: 'failed',
      idempotencyKey: 'idem-101',
      errorMessage: 'execution reverted: STF (swap too far)',
      triggeredAt: new Date(now - 144 * 3_600_000).toISOString(),
      completedAt: new Date(now - 144 * 3_600_000 + 12_000).toISOString(),
      rebalanceDetails: {
        oldNftTokenId: '811870',
        newNftTokenId: null,
        newTickLower: null,
        newTickUpper: null,
        feesCollectedToken0: null,
        feesCollectedToken1: null,
        gasUsedWei: 920_000_000_000_000,
        ethPriceUsd: 2103.45,
        positionToken0Start: null,
        positionToken1Start: null,
        positionToken0End: null,
        positionToken1End: null,
        swapCostAmountIn: null,
        swapCostAmountOut: null,
        swapCostFairAmountOut: null,
        swapCostDirection: null,
        swapCostUsd: null,
        priceAtDecision: null,
        priceAtEnd: null,
        priceDriftPct: null,
        priceDriftUsd: null,
        rebalancingDragUsd: null,
        hodlValueUsd: null,
      },
      transactions: [
        { id: 9,  txHash: '0xccc1230000000000000000000000000000000000000000000000000000000001', action: 'COLLECT_FEES', gasUsedWei: 560_000_000_000_000 },
        { id: 10, txHash: '0xccc1230000000000000000000000000000000000000000000000000000000002', action: 'BURN',          gasUsedWei: 360_000_000_000_000 },
      ],
    },
  ],
}

export const MOCK_WALLET_BALANCES = {
  address: '0xdeadbeefdeadbeefdeadbeefdeadbeef00000001',
  eth: '0.042',
  usdc: '12.50',
}
