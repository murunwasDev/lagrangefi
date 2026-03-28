import type { Strategy, StrategyStats, RebalanceEvent } from './types'

// ── Token helpers ────────────────────────────────────────────────────────────

export function rawToFloat(raw: string, decimals: number): number {
  return Number(BigInt(raw)) / Math.pow(10, decimals)
}

// ── Impermanent Loss (#1) ────────────────────────────────────────────────────
// IL = current_position_value_usd - hold_value_usd
// hold_value = what you'd have if you just held the initial tokens at current price
// Negative IL means you lost vs holding.

export interface ILResult {
  ilUsd: number       // negative = loss vs hold
  ilPct: number       // as % of deposit value
  holdValueUsd: number
  currentPositionUsd: number
}

export function computeIL(
  strategy: Strategy,
  dec0: number,
  dec1: number,
  label0: string,         // e.g. 'WETH'
  currentEthPrice: number,
  currentToken0Raw: string,
  currentToken1Raw: string,
): ILResult | null {
  if (!strategy.initialToken0Amount || !strategy.initialToken1Amount || !strategy.openEthPriceUsd) return null

  const init0 = rawToFloat(strategy.initialToken0Amount, dec0)
  const init1 = rawToFloat(strategy.initialToken1Amount, dec1)

  // Hold value at current price (same token amounts, new price)
  const holdValueUsd = label0.includes('WETH')
    ? init0 * currentEthPrice + init1
    : init1 * currentEthPrice + init0

  // Current position value
  const cur0 = rawToFloat(currentToken0Raw, dec0)
  const cur1 = rawToFloat(currentToken1Raw, dec1)
  const currentPositionUsd = label0.includes('WETH')
    ? cur0 * currentEthPrice + cur1
    : cur1 * currentEthPrice + cur0

  const ilUsd = currentPositionUsd - holdValueUsd
  const ilPct = strategy.initialValueUsd ? (ilUsd / strategy.initialValueUsd) * 100 : 0

  return { ilUsd, ilPct, holdValueUsd, currentPositionUsd }
}

// ── Total Return (#2) ────────────────────────────────────────────────────────
// For active:  (current_position_usd + fees_collected_usd) - initial_deposit_usd
// For stopped: (withdrawn_usd + fees_collected_usd) - initial_deposit_usd

export interface TotalReturnResult {
  totalReturnUsd: number
  totalReturnPct: number | null
  positionValueUsd: number   // current (active) or withdrawn (stopped)
  feesCollectedUsd: number
  gasSpentUsd: number
}

export function computeTotalReturn(
  strategy: Strategy,
  stats: StrategyStats,
  dec0: number,
  dec1: number,
  label0: string,
  currentEthPrice: number,
  // For active strategies: pass live position token amounts
  liveToken0Raw?: string,
  liveToken1Raw?: string,
): TotalReturnResult | null {
  if (!strategy.initialValueUsd) return null

  let positionValueUsd: number

  if (strategy.status === 'stopped') {
    if (stats.closeToken0Amount && stats.closeToken1Amount && stats.closeEthPriceUsd) {
      const c0 = rawToFloat(stats.closeToken0Amount, dec0)
      const c1 = rawToFloat(stats.closeToken1Amount, dec1)
      positionValueUsd = label0.includes('WETH')
        ? c0 * stats.closeEthPriceUsd + c1
        : c1 * stats.closeEthPriceUsd + c0
    } else if (stats.closeValueUsd != null) {
      positionValueUsd = stats.closeValueUsd
    } else {
      return null
    }
  } else {
    if (!liveToken0Raw || !liveToken1Raw) return null
    const t0 = rawToFloat(liveToken0Raw, dec0)
    const t1 = rawToFloat(liveToken1Raw, dec1)
    positionValueUsd = label0.includes('WETH')
      ? t0 * currentEthPrice + t1
      : t1 * currentEthPrice + t0
  }

  const feesCollectedUsd = stats.feesCollectedUsd > 0
    ? stats.feesCollectedUsd
    : (rawToFloat(stats.feesCollectedToken0, dec0) * currentEthPrice +
       rawToFloat(stats.feesCollectedToken1, dec1))

  const gasSpentUsd = stats.gasCostUsd > 0
    ? stats.gasCostUsd
    : (rawToFloat(stats.gasCostWei, 18) * currentEthPrice)

  const totalReturnUsd = (positionValueUsd + feesCollectedUsd) - strategy.initialValueUsd
  const totalReturnPct = strategy.initialValueUsd > 0
    ? (totalReturnUsd / strategy.initialValueUsd) * 100
    : null

  return { totalReturnUsd, totalReturnPct, positionValueUsd, feesCollectedUsd, gasSpentUsd }
}

// ── APY (#6) ─────────────────────────────────────────────────────────────────

export function computeAPY(
  totalReturnUsd: number,
  initialValueUsd: number,
  daysRunning: number,
): number | null {
  if (initialValueUsd <= 0 || daysRunning <= 0) return null
  const returnPct = totalReturnUsd / initialValueUsd
  return (returnPct / (daysRunning / 365)) * 100
}

// ── Break-even (#8) ──────────────────────────────────────────────────────────
// How much more in fees needed to recover all gas + open costs.
// Uses average fee rate from rebalances to estimate days remaining.

export interface BreakEvenResult {
  breakEvenUsd: number        // total cost basis (gas spent)
  feesCollectedUsd: number
  remainingUsd: number        // max(0, breakEvenUsd - feesCollectedUsd)
  isBreakEven: boolean
  estimatedDays: number | null
}

export function computeBreakEven(
  stats: StrategyStats,
  daysRunning: number,
): BreakEvenResult {
  const feesCollectedUsd = stats.feesCollectedUsd
  const breakEvenUsd = stats.gasCostUsd
  const remainingUsd = Math.max(0, breakEvenUsd - feesCollectedUsd)
  const isBreakEven = feesCollectedUsd >= breakEvenUsd

  let estimatedDays: number | null = null
  if (!isBreakEven && daysRunning > 0 && feesCollectedUsd > 0) {
    const dailyFeeRate = feesCollectedUsd / daysRunning
    estimatedDays = dailyFeeRate > 0 ? Math.ceil(remainingUsd / dailyFeeRate) : null
  }

  return { breakEvenUsd, feesCollectedUsd, remainingUsd, isBreakEven, estimatedDays }
}

// ── Token ratio (#9) ─────────────────────────────────────────────────────────
// Returns what % of position value is in token0 vs token1.

export interface TokenRatio {
  token0Pct: number
  token1Pct: number
  token0Usd: number
  token1Usd: number
  totalUsd: number
}

export function computeTokenRatio(
  token0Raw: string,
  token1Raw: string,
  dec0: number,
  dec1: number,
  label0: string,
  ethPrice: number,
): TokenRatio {
  const t0 = rawToFloat(token0Raw, dec0)
  const t1 = rawToFloat(token1Raw, dec1)
  const token0Usd = label0.includes('WETH') ? t0 * ethPrice : t0
  const token1Usd = label0.includes('WETH') ? t1 : t1 * ethPrice
  const totalUsd = token0Usd + token1Usd
  const token0Pct = totalUsd > 0 ? (token0Usd / totalUsd) * 100 : 50
  const token1Pct = 100 - token0Pct
  return { token0Pct, token1Pct, token0Usd, token1Usd, totalUsd }
}

// ── Per-rebalance profitability (#5) ─────────────────────────────────────────

export interface RebalanceProfit {
  feesUsd: number
  gasUsd: number
  netUsd: number
  isProfitable: boolean
}

export function computeRebalanceProfit(
  event: RebalanceEvent,
  dec0: number,
  dec1: number,
  label0: string,
): RebalanceProfit | null {
  if (!event.feesCollectedToken0 || !event.feesCollectedToken1 || !event.gasCostWei || !event.ethPriceUsd) return null
  const ethPrice = parseFloat(event.ethPriceUsd)
  const f0 = rawToFloat(event.feesCollectedToken0, dec0)
  const f1 = rawToFloat(event.feesCollectedToken1, dec1)
  const feesUsd = label0.includes('WETH') ? f0 * ethPrice + f1 : f1 * ethPrice + f0
  const gasUsd = rawToFloat(event.gasCostWei, 18) * ethPrice
  const netUsd = feesUsd - gasUsd
  return { feesUsd, gasUsd, netUsd, isProfitable: netUsd >= 0 }
}

// ── Historical USD values (#3) ───────────────────────────────────────────────
// Deposit value at open price (not current price)

export function depositValueAtOpen(
  strategy: Strategy,
  dec0: number,
  dec1: number,
  label0: string,
): number | null {
  if (!strategy.initialToken0Amount || !strategy.initialToken1Amount || !strategy.openEthPriceUsd) return null
  const t0 = rawToFloat(strategy.initialToken0Amount, dec0)
  const t1 = rawToFloat(strategy.initialToken1Amount, dec1)
  return label0.includes('WETH')
    ? t0 * strategy.openEthPriceUsd + t1
    : t1 * strategy.openEthPriceUsd + t0
}
