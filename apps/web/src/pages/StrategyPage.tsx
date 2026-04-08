import { useState, useEffect, useRef, useCallback, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchStrategies, startStrategy, createStrategy,
  stopStrategy,
  fetchStrategyStats, fetchStrategyRebalances,
  fetchPosition, fetchPoolState, fetchWalletBalances,
} from '../api'
import type { Strategy, StrategyStats, StrategyEvent, Position, PoolState } from '../types'
import { useAuth } from '../context/AuthContext'
import {
  computeCompareToHold, computeTotalReturn, computeAPY, computeBreakEven,
  computeTokenRatio, computeRebalanceProfit, rawToFloat, depositValueAtOpen,
} from '../finance'

interface WalletBalances { address: string; eth: string; usdc: string }

const FEE_TIERS = [
  { value: 100,   label: '0.01%' },
  { value: 500,   label: '0.05%' },
  { value: 3000,  label: '0.30%' },
  { value: 10000, label: '1.00%' },
]

const TOKEN_LABELS: Record<string, string> = {
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e',
}
function tokenLabel(addr: string) {
  return TOKEN_LABELS[addr.toLowerCase()] ?? addr.slice(0, 6) + '…' + addr.slice(-4)
}
function feeLabel(fee: number) { return (fee / 10000).toFixed(2) + '%' }
function shortHash(h: string) { return h.slice(0, 8) + '…' + h.slice(-6) }

function tickToPrice(tick: number, d0: number, d1: number) {
  return Math.pow(1.0001, tick) * Math.pow(10, d0 - d1)
}
function formatPrice(p: number) { return p.toLocaleString('en-US', { maximumFractionDigits: 2 }) }
function formatUsd(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}
function weiToEth(wei: number) { return (wei / 1e18).toFixed(6) }
const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉'
function toSub(n: number) {
  return n.toString().split('').map(d => SUBSCRIPT_DIGITS[+d]).join('')
}
function formatRaw(amount: string, decimals: number, sigFigs = 4): { compact: string; full: string } {
  const n = BigInt(amount), d = 10n ** BigInt(decimals)
  const whole = n / d
  const frac = (n % d).toString().padStart(decimals, '0')
  const leadingZeros = frac.match(/^0*/)?.[0].length ?? 0
  const significant = frac.slice(leadingZeros, leadingZeros + sigFigs).replace(/0+$/, '')
  const full = `${whole}.${frac.replace(/0+$/, '') || '0'}`
  let compact: string
  if (leadingZeros > 4 && significant) {
    compact = `${whole}.0${toSub(leadingZeros)}${significant}`
  } else {
    const trimmed = frac.slice(0, leadingZeros + sigFigs).replace(/0+$/, '')
    compact = trimmed ? `${whole}.${trimmed}` : `${whole}`
  }
  return { compact, full }
}

function daysRunning(createdAt: string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000)
}

function formatEventDate(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function computeUnclaimedFees(pos: Position, ethPrice: number, dec0: number, dec1: number) {
  if (!pos.tokensOwed0 || !pos.tokensOwed1) return null
  const t0 = Number(BigInt(pos.tokensOwed0)) / Math.pow(10, dec0)
  const t1 = Number(BigInt(pos.tokensOwed1)) / Math.pow(10, dec1)
  return { t0, t1, usd: t0 * ethPrice + t1 }
}

// ── Sub-components ───────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  ACTIVE:           'bg-emerald-50 text-emerald-700 border border-emerald-200',
  INITIATING:       'bg-blue-50 text-blue-700 border border-blue-200',
  STOPPED_MANUALLY: 'bg-gray-100 text-gray-500 border border-gray-200',
  STOPPED_ON_ERROR: 'bg-red-50 text-red-600 border border-red-200',
}
const STATUS_LABELS: Record<string, string> = {
  ACTIVE:           'Active',
  INITIATING:       'Starting',
  STOPPED_MANUALLY: 'Stopped',
  STOPPED_ON_ERROR: 'Error',
}

function isStopped(status: string) {
  return status === 'STOPPED_MANUALLY' || status === 'STOPPED_ON_ERROR'
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLES[status] ?? STATUS_STYLES.STOPPED_MANUALLY}`}>
      {status === 'ACTIVE' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
      {status === 'INITIATING' && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
      {STATUS_LABELS[status] ?? status}
    </span>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center gap-4 py-1.5 px-2.5 rounded-lg hover:bg-white/40 transition-colors">
      <span className="text-xs font-medium text-gray-400 shrink-0">{label}</span>
      <span className="text-xs font-semibold text-gray-800 font-mono text-right">{value}</span>
    </div>
  )
}

function Tooltip({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <span className="relative group/tip inline-block cursor-help">
      <span className="underline decoration-dotted decoration-gray-400 underline-offset-2">{children}</span>
      <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 hidden group-hover/tip:block
                       bg-gray-900 text-white text-xs font-mono rounded-lg px-2.5 py-1.5 whitespace-nowrap z-50 shadow-lg">
        {tip}
      </span>
    </span>
  )
}

function RawAmount({ amount, decimals, label, usd }: { amount: string; decimals: number; label: string; usd?: number }) {
  const { compact, full } = formatRaw(amount, decimals)
  const usdStr = usd != null ? ` (${formatUsd(usd)})` : ''
  const tip = usd != null ? `${full} ${label} (${formatUsd(usd)})` : `${full} ${label}`
  return <Tooltip tip={tip}>{compact} {label}{usdStr}</Tooltip>
}

function PriceRangeBar({ tick, tickLower, tickUpper, decimals0, decimals1 }: {
  tick: number; tickLower: number; tickUpper: number; decimals0: number; decimals1: number
}) {
  const inRange = tick >= tickLower && tick < tickUpper
  const pad = (tickUpper - tickLower) * 0.5
  const min = tickLower - pad, max = tickUpper + pad, total = max - min
  const loPct = ((tickLower - min) / total) * 100
  const hiPct = ((tickUpper - min) / total) * 100
  const curPct = Math.min(Math.max(((tick - min) / total) * 100, 0), 100)
  const lo = tickToPrice(tickLower, decimals0, decimals1)
  const hi = tickToPrice(tickUpper, decimals0, decimals1)
  const cur = tickToPrice(tick, decimals0, decimals1)
  return (
    <div className="mt-3">
      <div className="flex justify-between text-xs text-gray-400 mb-1.5">
        <span>${formatPrice(lo)}</span>
        <span className="font-medium text-gray-700">Now: ${formatPrice(cur)}</span>
        <span>${formatPrice(hi)}</span>
      </div>
      <div className="relative h-3 bg-gray-300 rounded-full">
        <div className={`absolute h-full rounded-full ${inRange ? 'bg-emerald-400' : 'bg-red-400'}`}
          style={{ left: `${loPct}%`, width: `${hiPct - loPct}%` }} />
        <div className={`absolute top-1/2 -translate-y-1/2 w-1 h-5 rounded-full ${inRange ? 'bg-emerald-600' : 'bg-red-600'}`}
          style={{ left: `${curPct}%` }} />
      </div>
      <div className="flex justify-between text-xs mt-1.5">
        <span className="text-gray-400">Lower bound</span>
        <span className={`font-semibold ${inRange ? 'text-emerald-600' : 'text-red-500'}`}>
          {inRange ? 'In Range' : 'Out of Range'}
        </span>
        <span className="text-gray-400">Upper bound</span>
      </div>
    </div>
  )
}

function TokenRatioBar({ token0Raw, token1Raw, dec0, dec1, label0, label1, ethPrice }: {
  token0Raw: string; token1Raw: string; dec0: number; dec1: number
  label0: string; label1: string; ethPrice: number
}) {
  const r = computeTokenRatio(token0Raw, token1Raw, dec0, dec1, label0, ethPrice)
  return (
    <div className="mt-3 pt-3 border-t border-white/50">
      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2">Token Ratio</p>
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="font-semibold text-blue-600">{label0} {r.token0Pct.toFixed(0)}%</span>
        <span className="text-[10px] text-gray-400">{formatUsd(r.totalUsd)}</span>
        <span className="font-semibold text-amber-600">{label1} {r.token1Pct.toFixed(0)}%</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden flex bg-gray-100">
        <div className="h-full bg-blue-400 transition-all duration-500" style={{ width: `${r.token0Pct}%` }} />
        <div className="h-full bg-amber-300 flex-1" />
      </div>
      <div className="flex justify-between text-[10px] text-gray-400 mt-1">
        <span>{formatUsd(r.token0Usd)}</span>
        <span>{formatUsd(r.token1Usd)}</span>
      </div>
    </div>
  )
}

// ── Activity Timeline ────────────────────────────────────────────────────────

function TxList({ hashes, steps }: { hashes: string[]; steps?: string[] | null }) {
  return (
    <div className="space-y-2">
      {hashes.map((h, i) => (
        <div key={h} className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide shrink-0 w-28 flex items-center gap-1.5">
            <span className="text-[9px] font-bold text-gray-300 tabular-nums">#{i + 1}</span>
            {steps?.[i] ?? `Tx ${i + 1}`}
          </span>
          <div className="flex items-center gap-1.5 min-w-0">
            <Tooltip tip={h}>
              <a href={`https://arbiscan.io/tx/${h}`} target="_blank" rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700 font-mono text-xs underline underline-offset-2">
                {shortHash(h)}
              </a>
            </Tooltip>
            <a href={`https://arbiscan.io/tx/${h}`} target="_blank" rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-600 shrink-0">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        </div>
      ))}
    </div>
  )
}

interface TimelineEventRowProps {
  iconBg: string
  icon: React.ReactNode
  dotColor: string
  label: string
  subtitle?: string
  date: string
  metric: string
  metricClass: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
  isLast?: boolean
}

function TimelineEventRow({
  iconBg, icon, dotColor, label, subtitle, date, metric, metricClass,
  expanded, onToggle, children, isLast,
}: TimelineEventRowProps) {
  return (
    <div className="relative pl-8">
      {!isLast && (
        <div className="absolute left-3.5 top-10 bottom-0 w-px bg-gradient-to-b from-gray-200 to-gray-100" />
      )}
      <div className={`absolute left-2 top-4 w-3 h-3 rounded-full border-2 border-white shadow-sm ${dotColor}`} />

      <div
        className="flex items-center gap-3 cursor-pointer py-3 px-3 rounded-xl hover:bg-white/40 transition-colors -mx-1"
        onClick={onToggle}
      >
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 leading-tight">{label}</p>
          {subtitle && <p className="text-xs text-gray-400 mt-0.5 truncate">{subtitle}</p>}
        </div>
        <span className="text-[11px] text-gray-400 shrink-0 hidden sm:block whitespace-nowrap">{date}</span>
        <span className={`text-sm font-bold font-mono shrink-0 ${metricClass}`}>{metric}</span>
        <svg className={`w-4 h-4 text-gray-300 transition-transform duration-200 shrink-0 ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {expanded && (
        <div className="pb-5 px-2 -mx-1">
          {children}
        </div>
      )}
    </div>
  )
}

function OpenedEvent({ strategy, openEvent, dec0, dec1, label0, label1, expanded, onToggle, isLast }: {
  strategy: Strategy; openEvent: StrategyEvent | undefined; dec0: number; dec1: number; label0: string; label1: string
  expanded: boolean; onToggle: () => void; isLast?: boolean
}) {
  const depositUsd = depositValueAtOpen(strategy, dec0, dec1, label0) ?? strategy.initialValueUsd

  return (
    <TimelineEventRow
      iconBg="bg-emerald-50 border border-emerald-200"
      icon={<svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18"/></svg>}
      dotColor="bg-emerald-400"
      label="Strategy Opened"
      subtitle={`NFT #${strategy.currentTokenId} · ${tokenLabel(strategy.token0)}/${tokenLabel(strategy.token1)} · ${feeLabel(strategy.fee)}`}
      date={formatEventDate(strategy.createdAt)}
      metric={depositUsd != null ? `Deposited ${formatUsd(depositUsd)}` : 'Deposited'}
      metricClass="text-gray-500"
      expanded={expanded}
      onToggle={onToggle}
      isLast={isLast}
    >
      <div className="space-y-2 mt-2">
        <div className="bg-white/60 border border-white/80 rounded-xl p-4 space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-3">
            Deposit{strategy.openEthPriceUsd ? ` · ETH = ${formatUsd(strategy.openEthPriceUsd)}` : ''}
          </p>
          {strategy.initialToken0Amount && (
            <div className="flex justify-between items-center">
              <span className="text-xs text-gray-600">
                <RawAmount amount={strategy.initialToken0Amount} decimals={dec0} label={label0} />
              </span>
              {strategy.openEthPriceUsd && (
                <span className="text-xs font-semibold font-mono text-gray-800">
                  {formatUsd(rawToFloat(strategy.initialToken0Amount, dec0) *
                    (label0.includes('WETH') ? strategy.openEthPriceUsd : 1))}
                </span>
              )}
            </div>
          )}
          {strategy.initialToken1Amount && (
            <div className="flex justify-between items-center">
              <span className="text-xs text-gray-600">
                <RawAmount amount={strategy.initialToken1Amount} decimals={dec1} label={label1} />
              </span>
              {strategy.openEthPriceUsd && (
                <span className="text-xs font-semibold font-mono text-gray-800">
                  {formatUsd(rawToFloat(strategy.initialToken1Amount, dec1) *
                    (label0.includes('WETH') ? 1 : strategy.openEthPriceUsd))}
                </span>
              )}
            </div>
          )}
          {depositUsd != null && (
            <div className="flex justify-between items-center pt-2 border-t border-gray-100 mt-1">
              <span className="text-xs font-semibold text-gray-600">Total deposited</span>
              <span className="text-sm font-bold font-mono text-gray-900">{formatUsd(depositUsd)}</span>
            </div>
          )}
        </div>

        {openEvent && openEvent.transactions.length > 0 && (
          <div className="bg-white/60 border border-white/80 rounded-xl p-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-3">Transactions</p>
            <TxList
              hashes={openEvent.transactions.map(t => t.txHash)}
              steps={openEvent.transactions.map(t => t.action)}
            />
          </div>
        )}
      </div>
    </TimelineEventRow>
  )
}

function RebalanceEventRow({ event, index, dec0, dec1, label0, label1, expanded, onToggle }: {
  event: StrategyEvent; index: number; dec0: number; dec1: number
  label0: string; label1: string; expanded: boolean; onToggle: () => void
}) {
  const d = event.rebalanceDetails
  const profit = computeRebalanceProfit(event, dec0, dec1, label0)
  const ethPrice = d?.ethPriceUsd ?? 0

  let metric: string
  let metricClass: string
  if (event.status === 'failed') {
    const gasUsd = d?.gasUsedWei != null && ethPrice > 0 ? (d.gasUsedWei / 1e18) * ethPrice : null
    metric = gasUsd != null ? `−${formatUsd(gasUsd)} gas` : 'Failed'
    metricClass = 'text-red-500'
  } else if (profit) {
    metric = (profit.netUsd >= 0 ? '+' : '') + formatUsd(profit.netUsd)
    metricClass = profit.isProfitable ? 'text-emerald-600' : 'text-red-500'
  } else {
    metric = '—'; metricClass = 'text-gray-400'
  }

  const hashes = event.transactions.map(t => t.txHash)
  const steps = event.transactions.map(t => t.action)

  const posBefore = (d?.positionToken0Start && d?.positionToken1Start && ethPrice > 0) ? (() => {
    const t0 = rawToFloat(d.positionToken0Start!, dec0)
    const t1 = rawToFloat(d.positionToken1Start!, dec1)
    return { t0, t1, usd: label0.includes('WETH') ? t0 * ethPrice + t1 : t1 * ethPrice + t0 }
  })() : null

  const posAfter = (d?.positionToken0End && d?.positionToken1End && ethPrice > 0) ? (() => {
    const t0 = rawToFloat(d.positionToken0End!, dec0)
    const t1 = rawToFloat(d.positionToken1End!, dec1)
    return { t0, t1, usd: label0.includes('WETH') ? t0 * ethPrice + t1 : t1 * ethPrice + t0 }
  })() : null

  const ratioBefore = (d?.positionToken0Start && d?.positionToken1Start && ethPrice > 0)
    ? computeTokenRatio(d.positionToken0Start!, d.positionToken1Start!, dec0, dec1, label0, ethPrice)
    : null
  const ratioAfter = (d?.positionToken0End && d?.positionToken1End && ethPrice > 0)
    ? computeTokenRatio(d.positionToken0End!, d.positionToken1End!, dec0, dec1, label0, ethPrice)
    : null

  return (
    <TimelineEventRow
      iconBg={event.status === 'failed' ? 'bg-red-50 border border-red-200' : 'bg-blue-50 border border-blue-200'}
      icon={event.status === 'failed'
        ? <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        : <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>}
      dotColor={event.status === 'failed' ? 'bg-red-400' : profit?.isProfitable !== false ? 'bg-blue-400' : 'bg-amber-400'}
      label={`Rebalance #${index}`}
      subtitle={event.status === 'failed'
        ? (event.errorMessage ?? 'Failed')
        : (d?.newTickLower != null
          ? `New range: $${formatPrice(tickToPrice(d.newTickLower, dec0, dec1))} → $${formatPrice(tickToPrice(d.newTickUpper!, dec0, dec1))}`
          : undefined)}
      date={formatEventDate(event.triggeredAt)}
      metric={metric}
      metricClass={metricClass}
      expanded={expanded}
      onToggle={onToggle}
    >
      <div className="space-y-2 mt-2">
        {event.status === 'failed' ? (
          <div className="bg-red-50/60 border border-red-200/60 rounded-xl p-4">
            <p className="text-xs font-semibold text-red-700">Error: {event.errorMessage ?? 'Unknown error'}</p>
            {d?.gasUsedWei != null && ethPrice > 0 && (
              <p className="text-xs text-red-500 mt-2">
                Gas lost: {formatUsd((d.gasUsedWei / 1e18) * ethPrice)} ({weiToEth(d.gasUsedWei)} ETH @ ${ethPrice.toFixed(0)})
              </p>
            )}
          </div>
        ) : (
          <>
            {(posBefore || posAfter) && (
              <div className="grid grid-cols-2 gap-2">
                {posBefore && (
                  <div className="bg-white/60 border border-white/80 rounded-xl p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">Before</p>
                    <p className="text-sm font-bold font-mono text-gray-700">{formatUsd(posBefore.usd)}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">
                      {posBefore.t0.toFixed(4)} {label0}<br/>
                      {posBefore.t1.toFixed(2)} {label1}
                    </p>
                  </div>
                )}
                {posAfter && (
                  <div className="bg-white/60 border border-white/80 rounded-xl p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">After</p>
                    <p className="text-sm font-bold font-mono text-gray-700">{formatUsd(posAfter.usd)}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">
                      {posAfter.t0.toFixed(4)} {label0}<br/>
                      {posAfter.t1.toFixed(2)} {label1}
                    </p>
                  </div>
                )}
              </div>
            )}

            {profit && (
              <div className="bg-white/60 border border-white/80 rounded-xl p-3 space-y-1.5">
                <div className="flex justify-between items-start">
                  <span className="text-xs text-emerald-700 flex items-center gap-1.5 mt-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                    Fees collected
                  </span>
                  <div className="text-right">
                    <p className="text-xs font-bold font-mono text-emerald-600">+{formatUsd(profit.feesUsd)}</p>
                    {d?.feesCollectedToken0 && (
                      <p className="text-[10px] text-gray-400 font-mono mt-0.5">
                        <RawAmount amount={d.feesCollectedToken0} decimals={dec0} label={label0} />
                        {' + '}
                        <RawAmount amount={d.feesCollectedToken1 ?? '0'} decimals={dec1} label={label1} />
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-red-600 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                    Gas
                  </span>
                  <span className="text-xs font-bold font-mono text-red-500">
                    −{formatUsd(profit.gasUsd)}
                    {d?.gasUsedWei != null && <span className="text-[10px] text-gray-400 ml-1">({weiToEth(d.gasUsedWei)} ETH)</span>}
                  </span>
                </div>
                <div className="flex justify-between items-center pt-1.5 border-t border-gray-100">
                  <span className="text-xs font-semibold text-gray-600">Net this rebalance</span>
                  <span className={`text-sm font-bold font-mono ${profit.isProfitable ? 'text-emerald-600' : 'text-red-500'}`}>
                    {profit.netUsd >= 0 ? '+' : ''}{formatUsd(profit.netUsd)}
                  </span>
                </div>
              </div>
            )}

            {/* Execution P&L breakdown — only shown when API provides price data */}
            {d?.priceAtDecision != null && (() => {
              const swapCostUsd = d.swapCostUsd ?? 0
              const driftUsd    = d.priceDriftUsd ?? 0
              const driftPct    = d.priceDriftPct ?? 0
              const pDecision   = d.priceAtDecision
              const pEnd        = d.priceAtEnd ?? pDecision
              const swapDir     = d.swapCostDirection
              const swapIn      = d.swapCostAmountIn ?? '0'
              const swapOut     = d.swapCostAmountOut ?? '0'
              const hasSwap     = d.swapCostAmountIn != null

              const swapInHuman  = swapDir === 'oneForZero'
                ? (Number(BigInt(swapIn)) / 1e18).toFixed(4) + ' ' + (label1.includes('WETH') ? label1 : label0)
                : (Number(BigInt(swapIn)) / 1e6).toFixed(2) + ' ' + (label0.includes('USDC') ? label0 : label1)
              const swapOutHuman = swapDir === 'oneForZero'
                ? (Number(BigInt(swapOut)) / 1e6).toFixed(2) + ' ' + (label0.includes('USDC') ? label0 : label1)
                : (Number(BigInt(swapOut)) / 1e18).toFixed(4) + ' ' + (label1.includes('WETH') ? label1 : label0)

              const driftIsPositive = driftUsd >= 0
              const totalImpact = (hasSwap ? -Math.abs(swapCostUsd) : 0) + driftUsd
              const totalImpactPositive = totalImpact >= 0

              return (
                <div className="bg-white/60 border border-white/80 rounded-xl p-3 space-y-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2">Execution Impact</p>

                  {/* Swap cost */}
                  {hasSwap !== false && (
                    <div className="flex justify-between items-start">
                      <span className="text-xs text-orange-600 flex items-center gap-1.5 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                        Swap cost
                      </span>
                      <div className="text-right">
                        <p className="text-xs font-bold font-mono text-orange-500">−{formatUsd(Math.abs(swapCostUsd))}</p>
                        <p className="text-[10px] text-gray-400 font-mono mt-0.5">{swapInHuman} → {swapOutHuman}</p>
                      </div>
                    </div>
                  )}

                  {/* Price drift */}
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="text-xs text-violet-600 flex items-center gap-1.5 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                        Price drift
                      </span>
                      <p className="text-[10px] text-gray-400 font-mono mt-0.5 ml-3.5">
                        ${formatPrice(pDecision)} → ${formatPrice(pEnd)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`text-xs font-bold font-mono ${driftIsPositive ? 'text-emerald-600' : 'text-red-500'}`}>
                        {driftIsPositive ? '+' : ''}{formatUsd(driftUsd)}
                      </p>
                      <p className={`text-[10px] font-mono mt-0.5 ${driftIsPositive ? 'text-emerald-500' : 'text-red-400'}`}>
                        {driftIsPositive ? '+' : ''}{driftPct.toFixed(2)}%
                      </p>
                    </div>
                  </div>

                  {/* Total execution impact */}
                  <div className="flex justify-between items-center pt-1.5 border-t border-gray-100">
                    <span className="text-xs font-medium text-gray-500">Execution impact</span>
                    <span className={`text-xs font-bold font-mono ${totalImpactPositive ? 'text-emerald-600' : 'text-red-500'}`}>
                      {totalImpactPositive ? '+' : ''}{formatUsd(totalImpact)}
                    </span>
                  </div>
                </div>
              )
            })()}

            {d?.rebalancingDragUsd != null && (() => {
              const il = d.rebalancingDragUsd!
              const ahead = il <= 0
              return (
                <div className={`bg-white/60 border rounded-xl p-3 space-y-1.5 ${ahead ? 'border-emerald-100/80' : 'border-orange-100/80'}`}>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2">Rebalancing Drag</p>
                  <div className="flex justify-between items-start">
                    <div>
                      <span className={`text-xs font-medium flex items-center gap-1.5 ${ahead ? 'text-emerald-700' : 'text-orange-600'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ahead ? 'bg-emerald-400' : 'bg-orange-400'}`} />
                        {ahead ? 'LP ahead of HODL' : 'HODL ahead of LP'}
                      </span>
                      {d.hodlValueUsd != null && (
                        <p className="text-[10px] text-gray-400 font-mono mt-0.5 ml-3">
                          HODL {formatUsd(d.hodlValueUsd)} vs LP {formatUsd(d.hodlValueUsd - il)}
                        </p>
                      )}
                    </div>
                    <p className={`text-xs font-bold font-mono ${ahead ? 'text-emerald-600' : 'text-orange-500'}`}>
                      {ahead ? '' : '+'}{formatUsd(il)}
                    </p>
                  </div>
                </div>
              )
            })()}

            {ratioBefore && ratioAfter && (
              <div className="bg-white/60 border border-white/80 rounded-xl p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2.5">Token Ratio Drift</p>
                <div className="space-y-2">
                  <div>
                    <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                      <span>Before</span>
                      <span>{label0} {ratioBefore.token0Pct.toFixed(0)}% / {label1} {ratioBefore.token1Pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden flex bg-gray-100">
                      <div className="h-full bg-blue-300" style={{ width: `${ratioBefore.token0Pct}%` }} />
                      <div className="h-full bg-amber-200 flex-1" />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                      <span>After</span>
                      <span>{label0} {ratioAfter.token0Pct.toFixed(0)}% / {label1} {ratioAfter.token1Pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden flex bg-gray-100">
                      <div className="h-full bg-blue-400 transition-all" style={{ width: `${ratioAfter.token0Pct}%` }} />
                      <div className="h-full bg-amber-300 flex-1" />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {hashes.length > 0 && (
          <div className="bg-white/60 border border-white/80 rounded-xl p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2.5">Transactions</p>
            <TxList hashes={hashes} steps={steps} />
          </div>
        )}
      </div>
    </TimelineEventRow>
  )
}

function ClosedEvent({ strategy, stats, closeEvent, dec0, dec1, label0, label1, expanded, onToggle }: {
  strategy: Strategy; stats: StrategyStats; closeEvent: StrategyEvent | undefined
  dec0: number; dec1: number; label0: string; label1: string; expanded: boolean; onToggle: () => void
}) {
  const depositUsd = depositValueAtOpen(strategy, dec0, dec1, label0) ?? strategy.initialValueUsd

  const withdrawUsd = (() => {
    if (strategy.endToken0Amount && strategy.endToken1Amount && strategy.endEthPriceUsd) {
      const t0 = rawToFloat(strategy.endToken0Amount, dec0)
      const t1 = rawToFloat(strategy.endToken1Amount, dec1)
      return label0.includes('WETH') ? t0 * strategy.endEthPriceUsd + t1 : t1 * strategy.endEthPriceUsd + t0
    }
    return strategy.endValueUsd ?? null
  })()

  const positionDelta = (depositUsd != null && withdrawUsd != null) ? withdrawUsd - depositUsd : null
  const feesUsd = stats.feesCollectedUsd
  const gasUsd = stats.gasCostUsd
  const netUsd = positionDelta != null ? positionDelta + feesUsd - gasUsd : null
  const netPct = (netUsd != null && depositUsd) ? (netUsd / depositUsd) * 100 : null

  const subtitle = strategy.status === 'STOPPED_ON_ERROR'
    ? (strategy.stopReason ?? 'Stopped on error')
    : strategy.endEthPriceUsd ? `ETH = ${formatUsd(strategy.endEthPriceUsd)}` : undefined

  return (
    <TimelineEventRow
      iconBg="bg-gray-100 border border-gray-200"
      icon={<svg className="w-4 h-4 text-gray-500" fill="currentColor" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>}
      dotColor={strategy.status === 'STOPPED_ON_ERROR' ? 'bg-red-400' : 'bg-gray-400'}
      label="Strategy Closed"
      subtitle={subtitle}
      date={strategy.stoppedAt ? formatEventDate(strategy.stoppedAt) : '—'}
      metric={netUsd != null ? `NET ${netUsd >= 0 ? '+' : ''}${formatUsd(netUsd)}` : '—'}
      metricClass={netUsd == null ? 'text-gray-400' : netUsd >= 0 ? 'text-emerald-600' : 'text-red-500'}
      expanded={expanded}
      onToggle={onToggle}
    >
      <div className="space-y-2 mt-2">
        <div className="bg-white/60 border border-white/80 rounded-xl p-4 space-y-2.5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-3">Final Summary</p>

          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-semibold text-gray-600">Deposited</p>
              {strategy.initialToken0Amount && strategy.initialToken1Amount && (
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {rawToFloat(strategy.initialToken0Amount, dec0).toFixed(4)} {label0} + {rawToFloat(strategy.initialToken1Amount, dec1).toFixed(2)} {label1}
                  {strategy.openEthPriceUsd ? ` at $${strategy.openEthPriceUsd.toFixed(0)}` : ''}
                </p>
              )}
            </div>
            <span className="text-sm font-bold font-mono text-gray-800">
              {depositUsd != null ? `−${formatUsd(depositUsd)}` : '—'}
            </span>
          </div>

          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-semibold text-gray-600">Withdrawn</p>
              {strategy.endToken0Amount && strategy.endToken1Amount && (
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {rawToFloat(strategy.endToken0Amount, dec0).toFixed(4)} {label0} + {rawToFloat(strategy.endToken1Amount, dec1).toFixed(2)} {label1}
                  {strategy.endEthPriceUsd ? ` at $${strategy.endEthPriceUsd.toFixed(0)}` : ''}
                </p>
              )}
            </div>
            <span className="text-sm font-bold font-mono text-emerald-700">
              {withdrawUsd != null ? `+${formatUsd(withdrawUsd)}` : '—'}
            </span>
          </div>

          <div className="border-t border-gray-100 pt-2 space-y-1.5">
            {positionDelta != null && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-500">Position change</span>
                <span className={`text-xs font-bold font-mono ${positionDelta >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                  {positionDelta >= 0 ? '+' : ''}{formatUsd(positionDelta)}
                </span>
              </div>
            )}
            <div className="flex justify-between items-center">
              <span className="text-xs text-emerald-700 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                Total fees earned
              </span>
              <span className="text-xs font-bold font-mono text-emerald-600">+{formatUsd(feesUsd)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-red-600 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                Total gas spent
              </span>
              <span className="text-xs font-bold font-mono text-red-500">−{formatUsd(gasUsd)}</span>
            </div>
          </div>

          {netUsd != null && (
            <div className="flex justify-between items-center pt-3 border-t-2 border-gray-200">
              <span className="text-base font-bold text-gray-900">NET</span>
              <div className="text-right">
                <span className={`text-2xl font-bold font-mono ${netUsd >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                  {netUsd >= 0 ? '+' : ''}{formatUsd(netUsd)}
                </span>
                {netPct != null && (
                  <p className={`text-xs font-semibold mt-0.5 ${netUsd >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                    {netUsd >= 0 ? '+' : ''}{netPct.toFixed(2)}% on deposit
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {closeEvent && closeEvent.transactions.length > 0 && (
          <div className="bg-white/60 border border-white/80 rounded-xl p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2.5">Transactions</p>
            <TxList
              hashes={closeEvent.transactions.map(t => t.txHash)}
              steps={closeEvent.transactions.map(t => t.action)}
            />
          </div>
        )}
      </div>
    </TimelineEventRow>
  )
}

function ActivityTimeline({ strategy, stats, events, dec0, dec1, label0, label1 }: {
  strategy: Strategy; stats: StrategyStats | undefined
  events: StrategyEvent[] | undefined
  dec0: number; dec1: number; label0: string; label1: string
}) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())

  function toggle(key: string) {
    setExpandedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  if (!events) {
    return <p className="text-gray-400 text-sm text-center py-8">Loading…</p>
  }

  const rebalanceEvents = [...events.filter(e => e.action === 'REBALANCE')].sort(
    (a, b) => new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime()
  )
  const openEvent = events.find(e => e.action === 'START_STRATEGY')
  const closeEvent = events.find(e => e.action === 'CLOSE_STRATEGY')
  const stopped = isStopped(strategy.status)
  const totalRows = (stopped ? 1 : 0) + rebalanceEvents.length + 1

  return (
    <div className="space-y-0">
      {stopped && stats && (
        <ClosedEvent
          strategy={strategy} stats={stats} closeEvent={closeEvent}
          dec0={dec0} dec1={dec1} label0={label0} label1={label1}
          expanded={expandedKeys.has('closed')} onToggle={() => toggle('closed')}
        />
      )}

      {rebalanceEvents.map((event, idx) => (
        <RebalanceEventRow
          key={event.id}
          event={event}
          index={rebalanceEvents.length - idx}
          dec0={dec0} dec1={dec1} label0={label0} label1={label1}
          expanded={expandedKeys.has(`r-${event.id}`)}
          onToggle={() => toggle(`r-${event.id}`)}
        />
      ))}

      <OpenedEvent
        strategy={strategy} openEvent={openEvent} dec0={dec0} dec1={dec1} label0={label0} label1={label1}
        expanded={expandedKeys.has('opened')} onToggle={() => toggle('opened')}
        isLast={totalRows > 0}
      />
    </div>
  )
}

// ── Onboarding ───────────────────────────────────────────────────────────────

function OnboardingState({ hasWallet }: { hasWallet: boolean }) {
  return (
    <div className="bg-white/60 backdrop-blur-xl rounded-2xl border border-white/70 shadow-lg shadow-black/5 flex flex-col items-center justify-center py-20 text-center">
      <div className="w-16 h-16 bg-white/60 backdrop-blur-sm rounded-2xl flex items-center justify-center mb-5 border border-white/80 shadow-sm">
        <span className="text-2xl font-bold text-gray-400">Δ</span>
      </div>
      <h2 className="text-lg font-bold text-gray-900 mb-2">Welcome to lagrangefi</h2>
      <p className="text-gray-500 text-sm max-w-xs mb-8">
        Automatically rebalances your Uniswap v3 ETH/USDC position to keep it in range.
      </p>
      <div className="flex flex-col items-center gap-3 w-full max-w-xs">
        <div className={`w-full flex items-center gap-4 rounded-2xl border p-4 ${
          hasWallet ? 'bg-emerald-50/60 border-emerald-200' : 'bg-white/60 backdrop-blur-sm border-white/80 shadow-sm'
        }`}>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
            hasWallet ? 'bg-emerald-500 text-white' : 'bg-gray-900 text-white'
          }`}>{hasWallet ? '✓' : '1'}</div>
          <div className="text-left">
            <p className={`text-sm font-semibold ${hasWallet ? 'text-emerald-700' : 'text-gray-900'}`}>
              {hasWallet ? 'Wallet configured' : 'Add your wallet'}
            </p>
            {!hasWallet && <p className="text-xs text-gray-400">BIP39 mnemonic or private key</p>}
          </div>
          {!hasWallet && (
            <Link to="/profile" className="ml-auto bg-gray-900 hover:bg-gray-800 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">
              Go →
            </Link>
          )}
        </div>
        <div className={`w-full flex items-center gap-4 rounded-2xl border p-4 ${
          hasWallet ? 'bg-white/60 backdrop-blur-sm border-white/80 shadow-sm' : 'bg-gray-100/40 border-gray-200/60 opacity-60'
        }`}>
          <div className="w-8 h-8 rounded-full bg-gray-900 text-white flex items-center justify-center text-sm font-bold shrink-0">2</div>
          <div className="text-left">
            <p className="text-sm font-semibold text-gray-900">Create a strategy</p>
            <p className="text-xs text-gray-400">Deposit ETH + USDC, set range width</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function StrategyPage({ view = 'dashboard' }: { view?: 'dashboard' | 'closed' }) {
  const { user } = useAuth()

  const [strategies,    setStrategies]  = useState<Strategy[]>([])
  const [stats,         setStats]       = useState<Record<number, StrategyStats>>({})
  const [rebalances,    setRebalances]  = useState<Record<number, StrategyEvent[]>>({})
  const [positions,     setPositions]   = useState<Record<number, Position>>({})
  const [poolStates,    setPoolStates]  = useState<Record<number, PoolState>>({})
  const [expandedId,    setExpandedId]  = useState<number | null>(null)
  const [tabMap,        setTabMap]      = useState<Record<number, 'overview' | 'history'>>({})
  const [confirmStopId, setConfirmStopId] = useState<number | null>(null)
  const [stoppingId,    setStoppingId]    = useState<number | null>(null)
  const [error,         setError]       = useState<string | null>(null)
  const [walletBalances, setWalletBalances] = useState<WalletBalances | null>(null)
  const [lastUpdated,   setLastUpdated] = useState<Date | null>(null)
  const [refreshing,    setRefreshing]  = useState(false)

  const [showCreate,    setShowCreate]   = useState(false)
  const [showAdvanced,  setShowAdvanced] = useState(false)
  const [createMode,    setCreateMode]   = useState<'mint' | 'register'>('mint')
  const [formState,     setFormState]    = useState<'form' | 'submitting' | 'success' | 'error'>('form')
  const [createName,    setCreateName]   = useState('')
  const [ethAmount,     setEthAmount]    = useState('')
  const [usdcAmount,    setUsdcAmount]   = useState('')
  const [feeTier,       setFeeTier]      = useState(500)
  const [createTokenId, setCreateTokenId] = useState('')
  const [createRange,   setCreateRange]  = useState(5)
  const [createSlippage, setCreateSlippage] = useState('0.5')
  const [createInterval, setCreateInterval] = useState('60')
  const [createError,   setCreateError]  = useState<string | null>(null)
  const [successData,   setSuccessData]  = useState<{ tokenId: string; txHashes: string[] } | null>(null)
  const balancesLoadedRef   = useRef(false)
  const autoLoadedActiveRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      setStrategies(await fetchStrategies())
      setLastUpdated(new Date())
      setError(null)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load strategies'
      if (msg !== 'Unauthorized') setError(msg)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
    const iv = setInterval(load, 30_000)
    return () => clearInterval(iv)
  }, [load])

  // Auto-load data for the active strategy whenever it first appears (or changes)
  useEffect(() => {
    const active = strategies.find(s => s.status === 'ACTIVE')
    if (!active) return
    if (autoLoadedActiveRef.current === active.id) return
    autoLoadedActiveRef.current = active.id
    loadStrategyData(active.id, true)
  }, [strategies]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadBalances() {
    if (balancesLoadedRef.current) return
    balancesLoadedRef.current = true
    try { setWalletBalances(await fetchWalletBalances()) }
    catch { /* optional */ }
  }

  function openCreate() {
    setShowCreate(true); setFormState('form')
    setCreateError(null); setSuccessData(null)
    setShowAdvanced(false); setCreateMode('mint')
    loadBalances()
  }
  function closeCreate() {
    setShowCreate(false); setFormState('form')
    setCreateError(null); setSuccessData(null)
  }

  async function loadStrategyData(id: number, isActive: boolean) {
    if (!tabMap[id]) setTabMap(prev => ({ ...prev, [id]: 'overview' }))
    const [s, r, pos, pool] = await Promise.all([
      fetchStrategyStats(id),
      fetchStrategyRebalances(id),
      isActive ? fetchPosition().catch(() => null) : Promise.resolve(null),
      isActive ? fetchPoolState().catch(() => null) : Promise.resolve(null),
    ])
    setStats(prev => ({ ...prev, [id]: s }))
    setRebalances(prev => ({ ...prev, [id]: r }))
    if (pos)  setPositions(prev  => ({ ...prev, [id]: pos }))
    if (pool) setPoolStates(prev => ({ ...prev, [id]: pool }))
  }

  async function expandStrategy(id: number) {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    const strategy = strategies.find(s => s.id === id)
    await loadStrategyData(id, strategy?.status === 'ACTIVE')
  }

  function setTab(id: number, tab: 'overview' | 'history') {
    setTabMap(prev => ({ ...prev, [id]: tab }))
  }

  async function handleStop(id: number) {
    setStoppingId(id)
    try {
      await stopStrategy(id)
      setConfirmStopId(null); setExpandedId(null); closeCreate(); load()
    } finally {
      setStoppingId(null)
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault(); setCreateError(null); setFormState('submitting')
    try {
      if (createMode === 'mint') {
        const result = await startStrategy({
          name: createName, ethAmount, usdcAmount, feeTier,
          rangePercent: createRange / 100,
          slippageTolerance: parseFloat(createSlippage) / 100,
          pollIntervalSeconds: parseInt(createInterval, 10),
        })
        setSuccessData(result); setFormState('success')
        balancesLoadedRef.current = false; load()
      } else {
        await createStrategy({
          name: createName, tokenId: createTokenId,
          rangePercent: createRange / 100,
          slippageTolerance: parseFloat(createSlippage) / 100,
          pollIntervalSeconds: parseInt(createInterval, 10),
        })
        closeCreate(); balancesLoadedRef.current = false; load()
      }
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create strategy')
      setFormState('error')
    }
  }

  const hasActive = strategies.some(s => s.status === 'ACTIVE')

  const prevHasActiveRef = useRef(hasActive)
  useEffect(() => {
    if (prevHasActiveRef.current && !hasActive && formState === 'success') {
      setShowCreate(false); setFormState('form')
      setCreateError(null); setSuccessData(null)
    }
    prevHasActiveRef.current = hasActive
  }, [hasActive, formState])

  const activeStrategies = strategies.filter(s => s.status === 'ACTIVE' || s.status === 'INITIATING')
  const closedStrategies = strategies.filter(s => isStopped(s.status))

  function renderStrategyCard(s: Strategy) {
    const pos      = positions[s.id]
    const pool     = poolStates[s.id]
    const st       = stats[s.id]
    const dec0     = s.token0Decimals ?? 18
    const dec1     = s.token1Decimals ?? 6
    const label0   = tokenLabel(s.token0)
    const label1   = tokenLabel(s.token1)
    const ethPrice = pool ? parseFloat(pool.price) : (s.endEthPriceUsd ?? 0)
    const inRange  = pool && pos ? pool.tick >= pos.tickLower && pool.tick < pos.tickUpper : null

    const latestSuccess = rebalances[s.id]?.find(r => r.action === 'REBALANCE' && r.status === 'success' && r.rebalanceDetails?.positionToken0End)
    const liveToken0 = pos?.amount0 ?? latestSuccess?.rebalanceDetails?.positionToken0End ?? null
    const liveToken1 = pos?.amount1 ?? latestSuccess?.rebalanceDetails?.positionToken1End ?? null

    const totalReturn = st ? computeTotalReturn(
      s, st, dec0, dec1, label0, ethPrice,
      liveToken0 ?? undefined, liveToken1 ?? undefined,
      pos?.tokensOwed0 ?? undefined, pos?.tokensOwed1 ?? undefined,
    ) : null
    const compareToHold = (s.status === 'ACTIVE' && totalReturn && ethPrice > 0)
      ? computeCompareToHold(s, dec0, dec1, label0, ethPrice, totalReturn.currentTotalValueUsd) : null
    const days = daysRunning(s.createdAt)
    const apy = (totalReturn?.totalReturnUsd != null && s.initialValueUsd && days > 0)
      ? computeAPY(totalReturn.totalReturnUsd, s.initialValueUsd, days) : null
    const breakEven = st ? computeBreakEven(st, days) : null
    const tab = tabMap[s.id] ?? 'overview'

    // Active strategy is always expanded; closed strategies toggle on click
    const isAlwaysExpanded = s.status === 'ACTIVE' || s.status === 'INITIATING'
    const isExpanded = isAlwaysExpanded || expandedId === s.id

    return (
      <div key={s.id} className={`relative backdrop-blur-xl rounded-2xl border shadow-lg transition-shadow hover:shadow-xl ${
        !isStopped(s.status)
          ? 'bg-white/65 border-white/70 shadow-emerald-100/50'
          : 'bg-white/50 border-white/60'
      }`}>
        {!isStopped(s.status) && (
          <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-2xl bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-400" />
        )}

        {/* Card header */}
        <div
          className={`flex items-center justify-between px-3 sm:px-5 py-3 sm:py-4 ${!isAlwaysExpanded ? 'cursor-pointer hover:bg-white/20 transition-colors' : ''}`}
          onClick={!isAlwaysExpanded ? () => expandStrategy(s.id) : undefined}
        >
          <div className="flex items-center gap-3 min-w-0">
            <StatusBadge status={s.status} />
            <span className="font-semibold text-gray-900 truncate">{s.name}</span>
            <span className="text-xs text-gray-400 font-mono shrink-0 hidden sm:inline">
              {label0}/{label1} · {feeLabel(s.fee)}
            </span>
            {!isStopped(s.status) && (
              <span className="text-xs text-gray-400 shrink-0 hidden md:inline">
                {days}d running
              </span>
            )}
            {s.status === 'ACTIVE' && inRange !== null && (
              <span className={`hidden lg:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                inRange
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${inRange ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                {inRange ? 'In Range' : 'Out of Range'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0 ml-2" onClick={e => e.stopPropagation()}>
            {!isStopped(s.status) && confirmStopId !== s.id && (
              <button onClick={() => setConfirmStopId(s.id)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-500/80
                           bg-red-500/8 backdrop-blur-sm border border-red-300/40
                           hover:text-red-600 hover:bg-red-500/15 hover:border-red-400/60
                           px-3 py-1.5 rounded-lg transition-all hover:shadow-sm hover:shadow-red-100">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="4" y="4" width="16" height="16" rx="2"/>
                </svg>
                Stop
              </button>
            )}
            {confirmStopId === s.id && (
              <div className="flex items-center gap-2 bg-white/80 backdrop-blur-md border border-red-100 rounded-xl px-3 py-1.5 shadow-lg shadow-red-500/10">
                <span className="text-xs text-gray-500 font-medium whitespace-nowrap">
                  {stoppingId === s.id ? 'Stopping…' : 'Stop permanently?'}
                </span>
                <button onClick={() => handleStop(s.id)} disabled={stoppingId === s.id}
                  className="inline-flex items-center gap-1 text-xs font-bold text-white
                             bg-gradient-to-r from-red-500 to-rose-600
                             hover:from-red-600 hover:to-rose-700
                             disabled:opacity-60 disabled:cursor-not-allowed
                             px-3 py-1 rounded-lg shadow-sm shadow-red-500/30 transition-all">
                  {stoppingId === s.id ? (
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                  ) : (
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                  )}
                  {stoppingId === s.id ? '' : 'Confirm'}
                </button>
                {stoppingId !== s.id && (
                  <button onClick={() => setConfirmStopId(null)}
                    className="text-xs font-medium text-gray-400 hover:text-gray-600 transition-colors">
                    Cancel
                  </button>
                )}
              </div>
            )}
            {!isAlwaysExpanded && (
              <svg
                className={`w-4 h-4 text-gray-300 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            )}
          </div>
        </div>

        {/* Expanded panel */}
        {isExpanded && (
          <div className="border-t border-white/50 px-3 sm:px-5 py-4 sm:py-5 bg-white/10">
            {/* Tabs */}
            <div className="flex gap-1 bg-gray-100/80 border border-gray-200/60 rounded-xl p-1 w-fit mb-5">
              {(['overview', 'history'] as const).map(t => (
                <button key={t} onClick={() => setTab(s.id, t)}
                  className={`px-4 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all ${
                    tab === t
                      ? 'bg-white text-gray-900 shadow-sm border border-gray-200/80'
                      : 'text-gray-400 hover:text-gray-600'
                  }`}>
                  {t}
                </button>
              ))}
            </div>

            {/* ── Overview tab ── */}
            {tab === 'overview' && (
              <div className="space-y-4">

                {/* Summary strip */}
                {st && (
                  <div className="bg-white/50 backdrop-blur-md border border-white/70 rounded-2xl overflow-hidden shadow-sm">
                    <div className="grid grid-cols-2 sm:grid-cols-4">

                      {/* Total Return — hero */}
                      <div className="relative px-5 py-4 border-b sm:border-b-0 sm:border-r border-white/50">
                        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-emerald-400/70 to-teal-300/50" />
                        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2.5">Total Return</p>
                        <p className={`text-xl font-bold tracking-tight ${
                          totalReturn == null ? 'text-gray-400' :
                          totalReturn.totalReturnUsd >= 0 ? 'text-emerald-600' : 'text-red-500'
                        }`}>
                          {totalReturn == null ? '—' :
                            (totalReturn.totalReturnUsd >= 0 ? '+' : '') + formatUsd(totalReturn.totalReturnUsd)}
                        </p>
                        {totalReturn?.totalReturnPct != null && (
                          <p className={`text-[10px] mt-1.5 font-semibold ${totalReturn.totalReturnUsd >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                            {totalReturn.totalReturnUsd >= 0 ? '+' : ''}{totalReturn.totalReturnPct.toFixed(2)}% on deposit
                          </p>
                        )}
                      </div>

                      {/* IL (active) / Position Δ (stopped) */}
                      <div className="relative px-5 py-4 border-b sm:border-b-0 sm:border-r border-white/50">
                        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-orange-400/70 to-amber-300/50" />
                        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2.5">
                          {s.status === 'ACTIVE' ? 'Compare to Hold' : 'Position Δ'}
                        </p>
                        {s.status === 'ACTIVE' ? (
                          compareToHold ? (
                            <>
                              <p className={`text-xl font-bold tracking-tight ${compareToHold.compareUsd < 0 ? 'text-emerald-600' : 'text-orange-500'}`}>
                                {compareToHold.compareUsd >= 0 ? '+' : ''}{formatUsd(compareToHold.compareUsd)}
                              </p>
                              <p className={`text-[10px] mt-1.5 font-semibold ${compareToHold.compareUsd < 0 ? 'text-emerald-500' : 'text-orange-400'}`}>
                                {compareToHold.comparePct.toFixed(2)}% {compareToHold.compareUsd < 0 ? 'LP ahead' : 'HODL ahead'}
                              </p>
                            </>
                          ) : (
                            <p className="text-xl font-bold text-gray-300">—</p>
                          )
                        ) : totalReturn ? (
                          <>
                            <p className={`text-xl font-bold tracking-tight ${
                              (totalReturn.currentTotalValueUsd - (s.initialValueUsd ?? 0)) >= 0 ? 'text-emerald-600' : 'text-red-500'
                            }`}>
                              {((totalReturn.currentTotalValueUsd - (s.initialValueUsd ?? 0)) >= 0 ? '+' : '') +
                                formatUsd(totalReturn.currentTotalValueUsd - (s.initialValueUsd ?? 0))}
                            </p>
                            <p className="text-[10px] mt-1.5 text-gray-400">deposit → withdraw</p>
                          </>
                        ) : <p className="text-xl font-bold text-gray-300">—</p>}
                      </div>

                      {/* APY */}
                      <div className="relative px-5 py-4 border-r border-white/50">
                        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-sky-400/70 to-blue-300/50" />
                        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2.5">APY</p>
                        <p className={`text-xl font-bold tracking-tight ${
                          apy == null ? 'text-gray-400' : apy >= 0 ? 'text-sky-600' : 'text-red-500'
                        }`}>
                          {apy == null ? '—' : (apy >= 0 ? '+' : '') + apy.toFixed(1) + '%'}
                        </p>
                        <p className="text-[10px] text-gray-400 mt-1.5">annualized · {days}d running</p>
                      </div>

                      {/* Time in range */}
                      <div className="relative px-5 py-4">
                        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-violet-400/70 to-purple-300/50" />
                        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2.5">In Range</p>
                        <p className={`text-xl font-bold tracking-tight ${
                          st.timeInRangePct >= 70 ? 'text-emerald-600' : st.timeInRangePct >= 40 ? 'text-amber-500' : 'text-red-500'
                        }`}>
                          {st.timeInRangePct.toFixed(1)}%
                        </p>
                        <div className="mt-2 h-1 bg-white/70 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${
                            st.timeInRangePct >= 70 ? 'bg-gradient-to-r from-emerald-400 to-teal-400' :
                            st.timeInRangePct >= 40 ? 'bg-amber-400' : 'bg-red-400'
                          }`} style={{ width: `${st.timeInRangePct}%` }} />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Main grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                  {/* Position card */}
                  <div className="bg-white/50 backdrop-blur-md border border-white/70 rounded-2xl shadow-sm">
                    <div className="bg-gradient-to-r from-blue-500/10 via-sky-400/6 to-transparent border-b border-blue-100/50 px-5 pt-4 pb-3 rounded-t-2xl">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <div className="w-0.5 h-4 rounded-full bg-gradient-to-b from-blue-400 to-sky-400" />
                          <h3 className="text-[10px] font-bold uppercase tracking-widest text-blue-500/90">Position</h3>
                        </div>
                        {pos && (
                          <div className="flex items-center gap-1.5 bg-white/60 border border-white/80 rounded-lg px-2.5 py-1">
                            <span className="text-[10px] text-gray-400">NFT</span>
                            <span className="text-xs font-mono font-bold text-gray-700">#{pos.tokenId}</span>
                            <span className={`text-[10px] font-bold ${BigInt(pos.liquidity) > 0n ? 'text-emerald-500' : 'text-red-400'}`}>
                              {BigInt(pos.liquidity) > 0n ? '●' : '○'}
                            </span>
                          </div>
                        )}
                      </div>
                      {s.status === 'ACTIVE' && pool && pos && (
                        <>
                          <p className="text-3xl font-bold text-gray-900 tracking-tight leading-none mt-2">
                            ${Number(pool.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                          </p>
                          <p className="text-xs text-gray-400 mt-1">{label0}/{label1} · {feeLabel(pos.fee)}</p>
                        </>
                      )}
                    </div>
                    <div className="px-5 py-4"
                      style={{ backgroundImage: 'radial-gradient(circle, rgba(99,102,241,0.07) 1px, transparent 1px)', backgroundSize: '18px 18px' }}>
                      {s.status !== 'ACTIVE' ? (
                        <div className="space-y-2">
                          <div className="flex items-center gap-3 bg-white/70 border border-white/80 rounded-xl px-3 py-2.5">
                            <span className="text-xs font-medium text-gray-400">NFT</span>
                            <span className="text-xs font-mono font-bold text-gray-700">#{s.currentTokenId}</span>
                            <span className="ml-auto text-xs text-gray-400">{label0}/{label1} · {feeLabel(s.fee)}</span>
                          </div>
                          <p className="text-xs text-gray-400 px-1">Live data available for active strategies only.</p>
                        </div>
                      ) : pos && pool ? (
                        <>
                          <PriceRangeBar
                            tick={pool.tick} tickLower={pos.tickLower} tickUpper={pos.tickUpper}
                            decimals0={pool.decimals0} decimals1={pool.decimals1}
                          />
                          {liveToken0 && liveToken1 && ethPrice > 0 && (
                            <TokenRatioBar
                              token0Raw={liveToken0} token1Raw={liveToken1}
                              dec0={dec0} dec1={dec1} label0={label0} label1={label1} ethPrice={ethPrice}
                            />
                          )}
                        </>
                      ) : (
                        <div className="flex items-center gap-2 text-gray-400 text-sm py-8 justify-center">
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                          </svg>
                          Loading…
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right column */}
                  <div className="flex flex-col gap-4">

                    {/* Performance card */}
                    <div className="bg-white/50 backdrop-blur-md border border-white/70 rounded-2xl shadow-sm">
                      <div className="bg-gradient-to-r from-emerald-500/10 via-teal-400/6 to-transparent border-b border-emerald-100/50 px-5 pt-4 pb-3 rounded-t-2xl">
                        <div className="flex items-center gap-2">
                          <div className="w-0.5 h-4 rounded-full bg-gradient-to-b from-emerald-400 to-teal-400" />
                          <h3 className="text-[10px] font-bold uppercase tracking-widest text-emerald-600/90">Performance</h3>
                        </div>
                      </div>
                      <div className="px-5 py-4">
                        {st ? (
                          <div className="space-y-1.5">

                            {/* Deposit row (at historical ETH price) */}
                            {s.initialValueUsd != null && (
                              <div className="flex justify-between items-start px-2.5 py-1.5 rounded-lg bg-gray-50/60 border border-gray-100/60">
                                <div>
                                  <span className="text-xs font-medium text-gray-500">Deposited</span>
                                  {s.openEthPriceUsd && (
                                    <p className="text-[10px] text-gray-400 mt-0.5">ETH = ${s.openEthPriceUsd.toFixed(0)} at open</p>
                                  )}
                                </div>
                                <span className="text-xs font-bold font-mono text-gray-700">{formatUsd(s.initialValueUsd)}</span>
                              </div>
                            )}

                            {/* Current/close position value */}
                            {totalReturn && (
                              <div className={`flex justify-between items-start px-2.5 py-1.5 rounded-lg border ${
                                s.status === 'ACTIVE'
                                  ? 'bg-blue-50/40 border-blue-100/50'
                                  : 'bg-gray-50/40 border-gray-100/50'
                              }`}>
                                <div>
                                  <span className="text-xs font-medium text-gray-500">
                                    {s.status === 'ACTIVE' ? 'Current position' : 'Withdrawn'}
                                  </span>
                                  {s.status === 'ACTIVE' && ethPrice > 0 && (
                                    <p className="text-[10px] text-gray-400 mt-0.5">ETH = ${ethPrice.toFixed(0)} now</p>
                                  )}
                                </div>
                                <span className="text-xs font-bold font-mono text-gray-700">{formatUsd(totalReturn.currentTotalValueUsd)}</span>
                              </div>
                            )}

                            {/* Fees earned */}
                            <div className="flex justify-between items-start px-2.5 py-1.5 rounded-lg bg-emerald-50/50 border border-emerald-100/60">
                              <span className="text-xs font-medium text-emerald-700 flex items-center gap-1.5 mt-0.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                                Fees earned
                              </span>
                              <div className="text-right">
                                <p className="text-xs font-bold text-emerald-600 font-mono">
                                  {st ? '+' + formatUsd(st.feesCollectedUsd) : '—'}
                                </p>
                                {st.feesCollectedToken0 !== '0' && (
                                  <p className="text-[11px] text-gray-400 font-mono mt-0.5">
                                    <RawAmount amount={st.feesCollectedToken0} decimals={dec0} label={label0} />
                                    {' + '}
                                    <RawAmount amount={st.feesCollectedToken1} decimals={dec1} label={label1} />
                                  </p>
                                )}
                              </div>
                            </div>

                            {/* Unclaimed fees (active only) */}
                            {s.status === 'ACTIVE' && pos && (() => {
                              const uf = computeUnclaimedFees(pos, ethPrice, dec0, dec1)
                              return uf ? (
                                <div className="flex justify-between items-start px-2.5 py-1.5 rounded-lg bg-sky-50/50 border border-sky-100/60">
                                  <span className="text-xs font-medium text-sky-700 flex items-center gap-1.5 mt-0.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
                                    Unclaimed fees
                                  </span>
                                  <div className="text-right">
                                    <p className="text-xs font-bold text-sky-600 font-mono">+{formatUsd(uf.usd)}</p>
                                    <p className="text-[11px] text-gray-400 font-mono mt-0.5">
                                      {uf.t0.toFixed(6)} {label0} · {uf.t1.toFixed(2)} {label1}
                                    </p>
                                  </div>
                                </div>
                              ) : null
                            })()}

                            {/* Gas spent */}
                            <div className="flex justify-between items-start px-2.5 py-1.5 rounded-lg bg-red-50/50 border border-red-100/60">
                              <span className="text-xs font-medium text-red-600 flex items-center gap-1.5 mt-0.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                                Gas spent
                              </span>
                              <div className="text-right">
                                <p className="text-xs font-bold text-red-500 font-mono">
                                  <Tooltip tip={`${st.gasCostWei} wei`}>
                                    {totalReturn ? '−' + formatUsd(totalReturn.gasSpentUsd) : weiToEth(st.gasCostWei) + ' ETH'}
                                  </Tooltip>
                                </p>
                                {totalReturn && (
                                  <p className="text-[11px] text-gray-400 font-mono mt-0.5">{weiToEth(st.gasCostWei)} ETH</p>
                                )}
                              </div>
                            </div>

                            {/* Swap costs */}
                            {st.swapCostUsd != null && st.swapCostUsd > 0 && (
                              <div className="flex justify-between items-start px-2.5 py-1.5 rounded-lg bg-orange-50/50 border border-orange-100/60">
                                <span className="text-xs font-medium text-orange-600 flex items-center gap-1.5 mt-0.5">
                                  <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                                  Swap costs
                                </span>
                                <div className="text-right">
                                  <p className="text-xs font-bold text-orange-500 font-mono">−{formatUsd(st.swapCostUsd)}</p>
                                  <p className="text-[11px] text-gray-400 font-mono mt-0.5">pool fee + slippage</p>
                                </div>
                              </div>
                            )}

                            {/* Avg price drift */}
                            {st.avgPriceDriftPct != null && (() => {
                              const driftPct = st.avgPriceDriftPct
                              const positive = driftPct >= 0
                              return (
                                <div className="flex justify-between items-start px-2.5 py-1.5 rounded-lg bg-violet-50/50 border border-violet-100/60">
                                  <div>
                                    <span className="text-xs font-medium text-violet-600 flex items-center gap-1.5 mt-0.5">
                                      <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                                      Avg price drift
                                    </span>
                                    <p className="text-[10px] text-gray-400 mt-0.5 ml-3.5">ETH move during execution</p>
                                  </div>
                                  <p className={`text-xs font-bold font-mono ${positive ? 'text-emerald-600' : 'text-red-500'}`}>
                                    {positive ? '+' : ''}{driftPct.toFixed(2)}% avg
                                  </p>
                                </div>
                              )
                            })()}

                            {/* Compare to Hold row (active only) */}
                            {s.status === 'ACTIVE' && compareToHold && (
                              <div className={`flex justify-between items-start px-2.5 py-1.5 rounded-lg border ${
                                compareToHold.compareUsd < 0
                                  ? 'bg-emerald-50/40 border-emerald-100/50'
                                  : 'bg-orange-50/40 border-orange-100/50'
                              }`}>
                                <div>
                                  <span className={`text-xs font-medium flex items-center gap-1.5 mt-0.5 ${compareToHold.compareUsd < 0 ? 'text-emerald-700' : 'text-orange-600'}`}>
                                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${compareToHold.compareUsd < 0 ? 'bg-emerald-400' : 'bg-orange-400'}`} />
                                    Compare to hold
                                  </span>
                                  <p className="text-[10px] text-gray-400 mt-0.5 ml-3">vs holding since open</p>
                                </div>
                                <div className="text-right">
                                  <p className={`text-xs font-bold font-mono ${compareToHold.compareUsd < 0 ? 'text-emerald-600' : 'text-orange-500'}`}>
                                    {compareToHold.compareUsd >= 0 ? '+' : ''}{formatUsd(compareToHold.compareUsd)}
                                  </p>
                                  <p className={`text-[10px] font-semibold mt-0.5 ${compareToHold.compareUsd < 0 ? 'text-emerald-500' : 'text-orange-400'}`}>
                                    {compareToHold.comparePct.toFixed(2)}%
                                  </p>
                                </div>
                              </div>
                            )}

                            {/* Rebalancing drag (last rebalance snapshot) */}
                            {st?.currentRebalancingDragUsd != null && (() => {
                              const il = st.currentRebalancingDragUsd!
                              const ahead = il <= 0
                              return (
                                <div className={`flex justify-between items-start px-2.5 py-1.5 rounded-lg border ${
                                  ahead ? 'bg-emerald-50/40 border-emerald-100/50' : 'bg-orange-50/40 border-orange-100/50'
                                }`}>
                                  <div>
                                    <span className={`text-xs font-medium flex items-center gap-1.5 mt-0.5 ${ahead ? 'text-emerald-700' : 'text-orange-600'}`}>
                                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ahead ? 'bg-emerald-400' : 'bg-orange-400'}`} />
                                      Rebalancing drag
                                    </span>
                                    <p className="text-[10px] text-gray-400 mt-0.5 ml-3">HODL − LP at last rebalance</p>
                                  </div>
                                  <p className={`text-xs font-bold font-mono ${ahead ? 'text-emerald-600' : 'text-orange-500'}`}>
                                    {ahead ? '' : '+'}{formatUsd(il)}
                                  </p>
                                </div>
                              )
                            })()}

                            {/* Fees/gas ratio bar */}
                            {st && totalReturn && st.feesCollectedUsd > 0 && (
                              <div className="h-1 rounded-full overflow-hidden flex mx-2.5 mt-1 bg-gray-100">
                                <div className="h-full bg-gradient-to-r from-emerald-400 to-emerald-500"
                                  style={{ width: `${Math.min((st.feesCollectedUsd / (st.feesCollectedUsd + totalReturn.gasSpentUsd)) * 100, 100)}%` }} />
                                <div className="h-full bg-gradient-to-r from-red-400 to-red-500"
                                  style={{ width: `${Math.min((totalReturn.gasSpentUsd / (st.feesCollectedUsd + totalReturn.gasSpentUsd)) * 100, 100)}%` }} />
                              </div>
                            )}

                            {/* Break-even */}
                            {breakEven && (
                              <div className="px-2.5 pt-2 mt-1">
                                <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                                  <span className="font-semibold">
                                    {breakEven.isBreakEven ? '✓ Gas recovered' : 'Gas recovery'}
                                  </span>
                                  <span>
                                    {breakEven.isBreakEven
                                      ? `${formatUsd(breakEven.feesCollectedUsd)} earned vs ${formatUsd(breakEven.breakEvenUsd)} gas`
                                      : `${formatUsd(breakEven.remainingUsd)} remaining${breakEven.estimatedDays != null ? ` · ~${breakEven.estimatedDays}d` : ''}`
                                    }
                                  </span>
                                </div>
                                <div className="h-1 rounded-full overflow-hidden bg-gray-100">
                                  <div className={`h-full rounded-full transition-all ${breakEven.isBreakEven ? 'bg-emerald-400' : 'bg-sky-400'}`}
                                    style={{ width: `${Math.min((breakEven.feesCollectedUsd / breakEven.breakEvenUsd) * 100, 100)}%` }} />
                                </div>
                              </div>
                            )}

                            {/* Stopped snapshot */}
                            {isStopped(s.status) && s.endEthPriceUsd != null && (
                              <div className="pt-3 border-t border-gray-100/80 space-y-1">
                                <p className="text-[11px] text-gray-400 font-medium px-2.5">At close · ETH = {formatUsd(s.endEthPriceUsd)}</p>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-gray-400 py-2 px-2.5">Loading…</p>
                        )}
                      </div>
                    </div>

                    {/* Config card */}
                    <div className="bg-white/50 backdrop-blur-md border border-white/70 rounded-2xl shadow-sm">
                      <div className="bg-gradient-to-r from-violet-500/10 via-purple-400/6 to-transparent border-b border-violet-100/50 px-5 pt-4 pb-3 rounded-t-2xl">
                        <div className="flex items-center gap-2">
                          <div className="w-0.5 h-4 rounded-full bg-gradient-to-b from-violet-400 to-purple-400" />
                          <h3 className="text-[10px] font-bold uppercase tracking-widest text-violet-500/90">Config</h3>
                        </div>
                      </div>
                      <div className="px-5 py-4">
                        <div className="flex flex-wrap gap-2 mb-3">
                          {[
                            `±${(s.rangePercent * 100).toFixed(0)}% range`,
                            `${(s.slippageTolerance * 100).toFixed(2)}% slip`,
                            `${s.pollIntervalSeconds}s poll`,
                            feeLabel(s.fee) + ' fee',
                          ].map(tag => (
                            <span key={tag} className="inline-flex items-center px-2.5 py-1 rounded-lg bg-white/70 border border-white/90 text-xs font-semibold text-gray-600 shadow-sm">
                              {tag}
                            </span>
                          ))}
                        </div>
                        <div className="space-y-0.5">
                          <InfoRow label="Started" value={new Date(s.createdAt).toLocaleDateString()} />
                          {!isStopped(s.status)
                            ? <InfoRow label="Running" value={`${days} days`} />
                            : s.stoppedAt ? <InfoRow label="Stopped" value={new Date(s.stoppedAt).toLocaleDateString()} /> : null
                          }
                          {s.initialToken0Amount && (
                            <InfoRow label={`Deposit ${label0}`} value={<RawAmount amount={s.initialToken0Amount} decimals={dec0} label={label0} />} />
                          )}
                          {s.initialToken1Amount && (
                            <InfoRow label={`Deposit ${label1}`} value={<RawAmount amount={s.initialToken1Amount} decimals={dec1} label={label1} />} />
                          )}
                        </div>
                      </div>
                    </div>

                  </div>{/* end right column */}
                </div>
              </div>
            )}

            {/* ── History tab ── */}
            {tab === 'history' && (
              <div className="bg-white/50 backdrop-blur-sm border border-white/70 rounded-2xl p-5 shadow-sm">
                <ActivityTimeline
                  strategy={s}
                  stats={st}
                  events={rebalances[s.id]}
                  dec0={dec0} dec1={dec1} label0={label0} label1={label1}
                />
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-y-3 mb-7">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{view === 'closed' ? 'Closed Strategies' : 'Dashboard'}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{view === 'closed' ? 'Historical records' : 'Uniswap v3 · Arbitrum'}</p>
        </div>
        <div className="flex items-center gap-3 mt-1">
          {refreshing ? (
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              Refreshing
            </span>
          ) : lastUpdated ? (
            <span className="text-xs text-gray-400">Updated {lastUpdated.toLocaleTimeString()}</span>
          ) : null}
          {view === 'dashboard' && (
            <button
              onClick={openCreate}
              disabled={hasActive}
              title={hasActive ? 'Stop your active strategy before creating a new one' : undefined}
              className="inline-flex items-center gap-2 bg-gray-900 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-sm hover:shadow transition-all"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New strategy
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-5 flex items-center justify-between bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          {error}
          <button onClick={() => setError(null)} className="ml-3 text-red-400 hover:text-red-600 shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* ── Create form ──────────────────────────────────────────────────── */}
      {view === 'dashboard' && showCreate && (!hasActive || formState === 'success') && (
        <div className="bg-white/60 backdrop-blur-xl rounded-2xl border border-white/70 shadow-lg shadow-black/5 p-6 mb-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-semibold text-gray-900">New strategy</h2>
            {formState !== 'submitting' && (
              <button onClick={closeCreate} className="text-gray-400 hover:text-gray-600 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {formState === 'success' && successData && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
                <span className="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center text-xs font-bold shrink-0">✓</span>
                <div>
                  <p className="text-sm font-semibold text-emerald-800">Strategy started!</p>
                  <p className="text-xs text-emerald-600 font-mono">Position NFT #{successData.tokenId}</p>
                </div>
              </div>
              {successData.txHashes.length > 0 && (
                <div className="bg-white/50 backdrop-blur-sm border border-white/70 rounded-2xl p-4 shadow-sm">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Transactions</p>
                  <TxList hashes={successData.txHashes} steps={['Approve', 'Mint Position']} />
                </div>
              )}
              <button onClick={closeCreate} className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">
                Close
              </button>
            </div>
          )}

          {formState !== 'success' && (
            <form onSubmit={handleCreate} className="space-y-5">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Strategy name</label>
                <input type="text" placeholder="My ETH/USDC strategy" value={createName}
                  onChange={e => setCreateName(e.target.value)} required
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white transition-colors" />
              </div>

              {walletBalances && (
                <div className="bg-blue-50/60 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-700 flex flex-wrap gap-x-3 gap-y-1">
                  <span>Wallet: <span className="font-mono font-medium">{walletBalances.address.slice(0, 8)}…</span></span>
                  <span className="font-medium">{Number(walletBalances.eth).toFixed(4)} ETH</span>
                  <span className="font-medium">{Number(walletBalances.usdc).toLocaleString('en-US', { maximumFractionDigits: 0 })} USDC</span>
                </div>
              )}

              {createMode === 'mint' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex justify-between items-baseline mb-1.5">
                      <label className="text-xs font-medium text-gray-600">ETH amount</label>
                      {walletBalances && (
                        <button type="button" onClick={() => setEthAmount(Number(walletBalances.eth).toFixed(4))}
                          className="text-xs text-blue-600 hover:text-blue-700 font-mono">
                          Max {Number(walletBalances.eth).toFixed(4)}
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <input type="number" min="0" step="0.0001" placeholder="0.0" value={ethAmount}
                        onChange={e => setEthAmount(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white pr-12" />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-medium">ETH</span>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between items-baseline mb-1.5">
                      <label className="text-xs font-medium text-gray-600">USDC amount</label>
                      {walletBalances && (
                        <button type="button" onClick={() => setUsdcAmount(Number(walletBalances.usdc).toFixed(2))}
                          className="text-xs text-blue-600 hover:text-blue-700 font-mono">
                          Max {Number(walletBalances.usdc).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <input type="number" min="0" step="any" placeholder="0.0" value={usdcAmount}
                        onChange={e => setUsdcAmount(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white pr-14" />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-medium">USDC</span>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Fee tier</label>
                <div className="grid grid-cols-4 gap-2">
                  {FEE_TIERS.map(ft => (
                    <button key={ft.value} type="button" onClick={() => setFeeTier(ft.value)}
                      className={`py-2 rounded-xl text-xs font-semibold border transition-colors ${
                        feeTier === ft.value
                          ? 'bg-gray-900 border-gray-900 text-white'
                          : 'bg-white border-gray-200 text-gray-600 hover:border-gray-400'
                      }`}>
                      {ft.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">
                  Price range — <span className="text-gray-900 font-semibold">±{createRange}%</span> from current price
                </label>
                <input type="range" min="1" max="20" step="1" value={createRange}
                  onChange={e => setCreateRange(Number(e.target.value))}
                  className="w-full accent-gray-900" />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>1% tight</span><span>20% wide</span>
                </div>
              </div>

              <div>
                <button type="button" onClick={() => setShowAdvanced(v => !v)}
                  className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 transition-colors">
                  <svg className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  Advanced settings
                </button>
                {showAdvanced && (
                  <div className="mt-3 space-y-4 bg-white/50 backdrop-blur-sm border border-white/70 rounded-2xl p-4 shadow-sm">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">Slippage (%)</label>
                        <input type="number" step="0.01" min="0.01" max="5" value={createSlippage}
                          onChange={e => setCreateSlippage(e.target.value)} required
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 focus:bg-white transition-colors" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">Poll interval (s)</label>
                        <input type="number" min="30" max="3600" value={createInterval}
                          onChange={e => setCreateInterval(e.target.value)} required
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 focus:bg-white transition-colors" />
                      </div>
                    </div>
                    <div className="pt-2 border-t border-gray-100">
                      <div className="flex items-center gap-2 mb-2">
                        <input type="checkbox" id="useRegister" checked={createMode === 'register'}
                          onChange={e => setCreateMode(e.target.checked ? 'register' : 'mint')}
                          className="accent-gray-900" />
                        <label htmlFor="useRegister" className="text-xs font-medium text-gray-600">
                          Track existing position NFT instead
                        </label>
                      </div>
                      {createMode === 'register' && (
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1.5">Position token ID</label>
                          <input
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 font-mono focus:outline-none focus:border-blue-500 focus:bg-white transition-colors"
                            value={createTokenId} onChange={e => setCreateTokenId(e.target.value)}
                            placeholder="123456" required={createMode === 'register'} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="bg-white/50 backdrop-blur-sm border border-white/70 rounded-2xl p-4 shadow-sm space-y-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Summary</p>
                {createMode === 'mint' ? (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">Deposit</span>
                      <span className="text-gray-700 font-mono">{ethAmount || '0'} ETH + {usdcAmount || '0'} USDC</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">Pool</span>
                      <span className="text-gray-700">WETH / USDC · {FEE_TIERS.find(f => f.value === feeTier)?.label}</span>
                    </div>
                  </>
                ) : (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">Position NFT</span>
                    <span className="text-gray-700 font-mono">#{createTokenId || '—'}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Range</span>
                  <span className="text-gray-700">±{createRange}% around current price</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Auto-rebalance</span>
                  <span className="text-emerald-600 font-semibold">Enabled</span>
                </div>
              </div>

              {createError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{createError}</p>
              )}

              <div className="flex gap-2">
                <button type="submit" disabled={formState === 'submitting'}
                  className="inline-flex items-center gap-2 bg-gray-900 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2.5 rounded-xl shadow-sm hover:shadow transition-all">
                  {formState === 'submitting' ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                      </svg>
                      Starting…
                    </>
                  ) : createMode === 'mint' ? 'Start strategy' : 'Register strategy'}
                </button>
                {formState !== 'submitting' && (
                  <button type="button" onClick={closeCreate}
                    className="text-gray-500 hover:text-gray-900 text-sm font-medium px-4 py-2.5 rounded-xl border border-gray-200 hover:border-gray-300 bg-white/60 hover:bg-white/80 transition-all">
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      )}

      {/* ── Strategy list ─────────────────────────────────────────────────── */}
      {view === 'dashboard' ? (
        strategies.length === 0 ? (
          <OnboardingState hasWallet={user?.hasWallet ?? false} />
        ) : activeStrategies.length > 0 ? (
          activeStrategies.map(renderStrategyCard)
        ) : (
          <div className="bg-white/40 backdrop-blur-xl rounded-2xl border border-dashed border-gray-200 px-6 py-10 text-center">
            <p className="text-sm font-medium text-gray-400">No active strategy</p>
            <p className="text-xs text-gray-400 mt-1">Use the "New strategy" button above to get started.</p>
          </div>
        )
      ) : (
        closedStrategies.length > 0 ? (
          <div className="space-y-3">
            {closedStrategies.map(renderStrategyCard)}
          </div>
        ) : (
          <div className="bg-white/40 backdrop-blur-xl rounded-2xl border border-dashed border-gray-200 px-6 py-10 text-center">
            <p className="text-sm font-medium text-gray-400">No closed strategies yet</p>
            <p className="text-xs text-gray-400 mt-1">Strategies you stop will appear here.</p>
          </div>
        )
      )}
    </div>
  )
}

