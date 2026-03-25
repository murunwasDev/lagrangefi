import { useEffect, useRef, useState } from 'react'
import type { Position, PoolState, RebalanceEvent, StartStrategyRequest, StartStrategyResult, WalletBalances } from './types'
import { fetchPosition, fetchPoolState, fetchRebalances, startStrategy, closePosition, fetchWalletBalances } from './api'

const TOKEN_LABELS: Record<string, string> = {
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e',
}

const FEE_TIERS = [
  { value: 100, label: '0.01%' },
  { value: 500, label: '0.05%' },
  { value: 3000, label: '0.30%' },
  { value: 10000, label: '1.00%' },
]

function tokenLabel(address: string) {
  return TOKEN_LABELS[address.toLowerCase()] ?? address.slice(0, 6) + '...' + address.slice(-4)
}

function feeLabel(fee: number) {
  return (fee / 10000).toFixed(2) + '%'
}

// Uniswap v3: price = 1.0001^tick * 10^(decimals0 - decimals1)
function tickToPrice(tick: number, decimals0: number, decimals1: number): string {
  const price = Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1)
  return '$' + price.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function shortHash(hash: string) {
  return hash.slice(0, 8) + '...' + hash.slice(-6)
}

function PriceRangeBar({ tick, tickLower, tickUpper, decimals0, decimals1 }: { tick: number; tickLower: number; tickUpper: number; decimals0: number; decimals1: number }) {
  const inRange = tick >= tickLower && tick < tickUpper
  const rangeWidth = tickUpper - tickLower
  const padding = rangeWidth * 0.5
  const min = tickLower - padding
  const max = tickUpper + padding
  const total = max - min

  const lowerPct = ((tickLower - min) / total) * 100
  const upperPct = ((tickUpper - min) / total) * 100
  const currentPct = Math.min(Math.max(((tick - min) / total) * 100, 0), 100)

  return (
    <div className="mt-4">
      <div className="flex justify-between text-xs text-slate-400 mb-1">
        <span>{tickToPrice(tickLower, decimals0, decimals1)}</span>
        <span>Current: {tickToPrice(tick, decimals0, decimals1)}</span>
        <span>{tickToPrice(tickUpper, decimals0, decimals1)}</span>
      </div>
      <div className="relative h-4 bg-slate-700 rounded-full overflow-visible">
        <div
          className={`absolute h-full rounded-full ${inRange ? 'bg-emerald-500/40' : 'bg-red-500/30'}`}
          style={{ left: `${lowerPct}%`, width: `${upperPct - lowerPct}%` }}
        />
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-full ${inRange ? 'bg-emerald-400' : 'bg-red-400'}`}
          style={{ left: `${currentPct}%` }}
        />
      </div>
    </div>
  )
}

function StatusBadge({ inRange }: { inRange: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
      inRange ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30' : 'bg-red-500/20 text-red-400 ring-1 ring-red-500/30'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${inRange ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
      {inRange ? 'In Range' : 'Out of Range'}
    </span>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-4">{title}</h2>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-slate-700/40 last:border-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-sm font-mono text-slate-200">{value}</span>
    </div>
  )
}

// ─── Start Strategy Modal ────────────────────────────────────────────────────

type ModalState = 'form' | 'executing' | 'success' | 'error'

interface StepEntry {
  label: string
  status: 'pending' | 'active' | 'done'
}

const EXECUTION_STEPS = [
  'Wrapping ETH → WETH',
  'Calculating optimal swap',
  'Executing token swap',
  'Minting LP position',
]

function StartStrategyModal({ onClose, onSuccess, walletBalances }: { onClose: () => void; onSuccess: () => void; walletBalances: WalletBalances | null }) {
  const [modalState, setModalState] = useState<ModalState>('form')
  const [form, setForm] = useState<StartStrategyRequest>({
    ethAmount: '',
    usdcAmount: '',
    feeTier: 500,
    rangePercent: 5,
  })
  const [steps, setSteps] = useState<StepEntry[]>(
    EXECUTION_STEPS.map(label => ({ label, status: 'pending' }))
  )
  const [result, setResult] = useState<StartStrategyResult | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const activeStepRef = useRef<number>(-1)

  function updateStep(label: string) {
    const idx = EXECUTION_STEPS.indexOf(label)
    if (idx === -1) return
    activeStepRef.current = idx
    setSteps(prev => prev.map((s, i) => ({
      ...s,
      status: i < idx ? 'done' : i === idx ? 'active' : 'pending',
    })))
  }

  async function handleStart() {
    const eth = parseFloat(form.ethAmount)
    const usdc = parseFloat(form.usdcAmount)
    if ((!form.ethAmount && !form.usdcAmount) || (isNaN(eth) && isNaN(usdc))) {
      setValidationError('Enter at least one amount')
      return
    }
    if (form.ethAmount && (isNaN(eth) || eth < 0)) {
      setValidationError('Invalid ETH amount')
      return
    }
    if (form.usdcAmount && (isNaN(usdc) || usdc < 0)) {
      setValidationError('Invalid USDC amount')
      return
    }
    if (walletBalances) {
      if (form.ethAmount && eth > parseFloat(walletBalances.eth)) {
        setValidationError(`Insufficient ETH — available: ${Number(walletBalances.eth).toFixed(4)}`)
        return
      }
      if (form.usdcAmount && usdc > parseFloat(walletBalances.usdc)) {
        setValidationError(`Insufficient USDC — available: ${Number(walletBalances.usdc).toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
        return
      }
    }
    setValidationError(null)
    setModalState('executing')
    setSteps(EXECUTION_STEPS.map(label => ({ label, status: 'pending' })))

    try {
      const res = await startStrategy(
        { ...form, rangePercent: form.rangePercent / 100 },
        updateStep,
      )
      // mark all steps done on success
      setSteps(EXECUTION_STEPS.map(label => ({ label, status: 'done' })))
      setResult(res)
      if (res.success) {
        setModalState('success')
      } else {
        setModalState('error')
      }
    } catch {
      setResult({ success: false, error: 'Network error — could not reach API' })
      setModalState('error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={modalState === 'executing' ? undefined : onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-700/50">
          <div>
            <h2 className="text-lg font-semibold text-white">Start Strategy</h2>
            <p className="text-xs text-slate-400 mt-0.5">Create a new Uniswap v3 LP position</p>
          </div>
          {modalState !== 'executing' && (
            <button onClick={onClose} className="text-slate-400 hover:text-slate-200 transition-colors">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className="px-6 py-5">
          {/* ── FORM ── */}
          {modalState === 'form' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex justify-between items-baseline mb-1.5">
                    <label className="text-xs font-medium text-slate-400">ETH Amount</label>
                    {walletBalances && (
                      <span className="text-xs text-slate-500">
                        Available: <button
                          type="button"
                          onClick={() => setForm(f => ({ ...f, ethAmount: walletBalances.eth }))}
                          className="text-blue-400 hover:text-blue-300 font-mono underline-offset-2 hover:underline"
                        >{Number(walletBalances.eth).toFixed(4)}</button>
                      </span>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      placeholder="0.0"
                      value={form.ethAmount}
                      onChange={e => setForm(f => ({ ...f, ethAmount: e.target.value }))}
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 pr-12"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-medium">ETH</span>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between items-baseline mb-1.5">
                    <label className="text-xs font-medium text-slate-400">USDC Amount</label>
                    {walletBalances && (
                      <span className="text-xs text-slate-500">
                        Available: <button
                          type="button"
                          onClick={() => setForm(f => ({ ...f, usdcAmount: Number(walletBalances.usdc).toFixed(2) }))}
                          className="text-blue-400 hover:text-blue-300 font-mono underline-offset-2 hover:underline"
                        >{Number(walletBalances.usdc).toLocaleString('en-US', { maximumFractionDigits: 2 })}</button>
                      </span>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder="0.0"
                      value={form.usdcAmount}
                      onChange={e => setForm(f => ({ ...f, usdcAmount: e.target.value }))}
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 pr-14"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-medium">USDC</span>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Fee Tier</label>
                <div className="grid grid-cols-4 gap-2">
                  {FEE_TIERS.map(ft => (
                    <button
                      key={ft.value}
                      onClick={() => setForm(f => ({ ...f, feeTier: ft.value }))}
                      className={`py-2 rounded-lg text-xs font-medium border transition-colors ${
                        form.feeTier === ft.value
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-slate-800 border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {ft.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Price Range — <span className="text-white">±{form.rangePercent}%</span> from current price
                </label>
                <input
                  type="range"
                  min="1"
                  max="20"
                  step="1"
                  value={form.rangePercent}
                  onChange={e => setForm(f => ({ ...f, rangePercent: Number(e.target.value) }))}
                  className="w-full accent-blue-500"
                />
                <div className="flex justify-between text-xs text-slate-500 mt-1">
                  <span>1% (narrow)</span>
                  <span>20% (wide)</span>
                </div>
              </div>

              {/* Summary */}
              <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3 space-y-1.5">
                <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">Summary</p>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Deposit</span>
                  <span className="text-slate-300 font-mono">
                    {form.ethAmount || '0'} ETH + {form.usdcAmount || '0'} USDC
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Pool</span>
                  <span className="text-slate-300">WETH / USDC · {FEE_TIERS.find(f => f.value === form.feeTier)?.label}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Range</span>
                  <span className="text-slate-300">±{form.rangePercent}% around current price</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Auto-rebalance</span>
                  <span className="text-emerald-400">Enabled</span>
                </div>
              </div>

              {validationError && (
                <p className="text-xs text-red-400">{validationError}</p>
              )}

              <button
                onClick={handleStart}
                className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition-colors text-sm"
              >
                Start Strategy
              </button>
            </div>
          )}

          {/* ── EXECUTING ── */}
          {modalState === 'executing' && (
            <div className="space-y-3">
              <p className="text-xs text-slate-400 mb-4">Executing on-chain transactions. Do not close this window.</p>
              {steps.map((step, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                    step.status === 'done' ? 'bg-emerald-500/20 text-emerald-400' :
                    step.status === 'active' ? 'bg-blue-500/20 text-blue-400' :
                    'bg-slate-700 text-slate-500'
                  }`}>
                    {step.status === 'done' ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : step.status === 'active' ? (
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                    ) : (
                      <span className="text-xs font-mono">{i + 1}</span>
                    )}
                  </div>
                  <span className={`text-sm ${
                    step.status === 'done' ? 'text-slate-300' :
                    step.status === 'active' ? 'text-white font-medium' :
                    'text-slate-500'
                  }`}>
                    {step.label}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ── SUCCESS ── */}
          {modalState === 'success' && result && (
            <div className="text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto">
                <svg className="w-7 h-7 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-white font-semibold">Strategy Started!</p>
                <p className="text-slate-400 text-sm mt-1">
                  Position <span className="text-white font-mono">#{result.tokenId}</span> is now active and will auto-rebalance.
                </p>
              </div>
              {result.txHashes && result.txHashes.length > 0 && (
                <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3 text-left space-y-1.5">
                  <p className="text-xs text-slate-500 uppercase tracking-wider font-medium mb-2">Transactions</p>
                  {result.txHashes.map((h, i) => (
                    <div key={h} className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">
                        {['Wrap', 'Swap', 'Mint'][i] ?? `Tx ${i + 1}`}
                      </span>
                      <a
                        href={`https://arbiscan.io/tx/${h}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-400 hover:text-blue-300 font-mono underline"
                      >
                        {shortHash(h)}
                      </a>
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={() => { onSuccess(); onClose() }}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl transition-colors text-sm"
              >
                View Dashboard
              </button>
            </div>
          )}

          {/* ── ERROR ── */}
          {modalState === 'error' && result && (
            <div className="text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-red-500/20 flex items-center justify-center mx-auto">
                <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <div>
                <p className="text-white font-semibold">Transaction Failed</p>
                <p className="text-slate-400 text-sm mt-1">{result.error ?? 'Unknown error occurred'}</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 py-3 bg-slate-700 hover:bg-slate-600 text-white font-medium rounded-xl transition-colors text-sm"
                >
                  Close
                </button>
                <button
                  onClick={() => setModalState('form')}
                  className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition-colors text-sm"
                >
                  Try Again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [position, setPosition] = useState<Position | null>(null)
  const [poolState, setPoolState] = useState<PoolState | null>(null)
  const [rebalances, setRebalances] = useState<RebalanceEvent[]>([])
  const [walletBalances, setWalletBalances] = useState<WalletBalances | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [positionError, setPositionError] = useState<string | null>(null)
  const [poolStateError, setPoolStateError] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [positionLoaded, setPositionLoaded] = useState(false)
  const [closeState, setCloseState] = useState<'idle' | 'confirm' | 'closing' | 'done' | 'error'>('idle')
  const [closeError, setCloseError] = useState<string | null>(null)

  async function handleClose() {
    setCloseState('closing')
    setCloseError(null)
    try {
      const result = await closePosition()
      if (result.success) {
        setCloseState('done')
        setPosition(null)
        await fetchAll()
      } else {
        setCloseError(result.error ?? 'Close failed')
        setCloseState('error')
      }
    } catch {
      setCloseError('Request failed')
      setCloseState('error')
    }
  }

  async function fetchAll() {
    const [pos, pool, rebal, wallet] = await Promise.allSettled([
      fetchPosition(),
      fetchPoolState(),
      fetchRebalances(),
      fetchWalletBalances(),
    ])

    if (pos.status === 'fulfilled') {
      setPosition(pos.value)
      setPositionError(null)
    } else {
      setPositionError('Could not load position data')
    }

    if (pool.status === 'fulfilled') {
      setPoolState(pool.value)
      setPoolStateError(null)
    } else {
      setPoolStateError('Could not load pool data')
    }

    if (rebal.status === 'fulfilled') setRebalances(rebal.value)
    if (wallet.status === 'fulfilled') setWalletBalances(wallet.value)

    setLastUpdated(new Date())
    setPositionLoaded(true)
  }

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, 30_000)
    return () => clearInterval(interval)
  }, [])

  const inRange = poolState && position
    ? poolState.tick >= position.tickLower && poolState.tick < position.tickUpper
    : null

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">lagrangefi</h1>
          <p className="text-sm text-slate-400 mt-0.5">Uniswap v3 Auto-Rebalancer · Arbitrum</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            {inRange !== null && <StatusBadge inRange={inRange} />}
            {lastUpdated && (
              <p className="text-xs text-slate-500 mt-1">
                Updated {lastUpdated.toLocaleTimeString()}
              </p>
            )}
          </div>
          {positionLoaded && position && BigInt(position.liquidity) > 0n && (
            closeState === 'confirm' ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-300">Close position?</span>
                <button
                  onClick={handleClose}
                  className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-sm font-semibold rounded-xl transition-colors"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setCloseState('idle')}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-sm font-semibold rounded-xl transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : closeState === 'closing' ? (
              <button disabled className="flex items-center gap-2 px-4 py-2 bg-red-800 text-red-300 text-sm font-semibold rounded-xl cursor-not-allowed">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Closing...
              </button>
            ) : (
              <button
                onClick={() => setCloseState('confirm')}
                className="flex items-center gap-2 px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-xl transition-colors"
              >
                Close Position
              </button>
            )
          )}
          {positionLoaded && (!position || BigInt(position.liquidity) === 0n) && (
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Start Strategy
            </button>
          )}
          {closeState === 'error' && closeError && (
            <span className="text-xs text-red-400">{closeError}</span>
          )}
        </div>
      </div>

      {positionLoaded && positionError && poolStateError && (
        <div className="mb-6 bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-4 py-3 flex items-center justify-between">
          <span>API is unreachable — data may be stale</span>
          <button onClick={fetchAll} className="ml-4 underline hover:text-red-300">Retry</button>
        </div>
      )}

      {/* Wallet Balances */}
      {walletBalances && (
        <div className="mb-4 bg-slate-800/50 border border-slate-700/50 rounded-xl px-5 py-3 flex items-center gap-6">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Wallet</span>
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-slate-400">ETH</span>
            <span className="text-sm font-mono text-white">{Number(walletBalances.eth).toFixed(4)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-slate-400">USDC</span>
            <span className="text-sm font-mono text-white">{Number(walletBalances.usdc).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
          </div>
          <span className="text-xs text-slate-600 font-mono ml-auto">{walletBalances.address.slice(0, 6)}…{walletBalances.address.slice(-4)}</span>
        </div>
      )}

      {/* Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <Card title="Position">
          {!positionLoaded ? (
            <p className="text-slate-500 text-sm animate-pulse">Loading...</p>
          ) : positionError ? (
            <p className="text-red-400 text-sm">{positionError}</p>
          ) : position ? (
            <>
              <Row label="Token ID" value={`#${position.tokenId}`} />
              <Row label="Pair" value={`${tokenLabel(position.token0)} / ${tokenLabel(position.token1)}`} />
              <Row label="Fee Tier" value={feeLabel(position.fee)} />
              <Row label="Price Range" value={`${poolState ? tickToPrice(position.tickLower, poolState.decimals0, poolState.decimals1) : position.tickLower} → ${poolState ? tickToPrice(position.tickUpper, poolState.decimals0, poolState.decimals1) : position.tickUpper}`} />
              <Row label="Liquidity" value={BigInt(position.liquidity) > 0n ? '✓ Active' : '— Empty'} />
            </>
          ) : (
            <p className="text-slate-500 text-sm">No active position</p>
          )}
        </Card>

        <Card title="Pool State">
          {!positionLoaded ? (
            <p className="text-slate-500 text-sm animate-pulse">Loading...</p>
          ) : poolStateError ? (
            <p className="text-red-400 text-sm">{poolStateError}</p>
          ) : poolState ? (
            <>
              <Row label="Price (USDC/WETH)" value={`$${Number(poolState.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}`} />
              <Row label="Current Price (tick)" value={`${tickToPrice(poolState.tick, poolState.decimals0, poolState.decimals1)} (${poolState.tick})`} />
              <Row label="Status" value={inRange !== null ? <StatusBadge inRange={inRange} /> : '—'} />
            </>
          ) : (
            <p className="text-slate-500 text-sm">Loading...</p>
          )}
          {poolState && position && (
            <PriceRangeBar tick={poolState.tick} tickLower={position.tickLower} tickUpper={position.tickUpper} decimals0={poolState.decimals0} decimals1={poolState.decimals1} />
          )}
        </Card>
      </div>

      {/* Rebalance History */}
      <Card title="Rebalance History">
        {rebalances.length === 0 ? (
          <p className="text-slate-500 text-sm py-4 text-center">No rebalances yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-700">
                  <th className="text-left pb-2 font-medium">Time</th>
                  <th className="text-left pb-2 font-medium">Status</th>
                  <th className="text-left pb-2 font-medium">New Range</th>
                  <th className="text-left pb-2 font-medium">Tx</th>
                </tr>
              </thead>
              <tbody>
                {rebalances.map(r => (
                  <tr key={r.id} className="border-b border-slate-700/40 last:border-0">
                    <td className="py-2 text-slate-400 font-mono text-xs">
                      {new Date(r.triggeredAt).toLocaleString()}
                    </td>
                    <td className="py-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        r.status === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
                        r.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                        'bg-yellow-500/20 text-yellow-400'
                      }`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="py-2 text-slate-300 font-mono text-xs">
                      {r.newTickLower != null ? `${r.newTickLower} → ${r.newTickUpper}` : '—'}
                    </td>
                    <td className="py-2 text-slate-400 font-mono text-xs">
                      {r.txHashes
                        ? JSON.parse(r.txHashes).slice(0, 1).map((h: string) => (
                            <a key={h} href={`https://arbiscan.io/tx/${h}`} target="_blank" rel="noopener noreferrer"
                               className="text-blue-400 hover:text-blue-300 underline">
                              {shortHash(h)}
                            </a>
                          ))
                        : r.errorMessage ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Start Strategy Modal */}
      {showModal && (
        <StartStrategyModal
          onClose={() => setShowModal(false)}
          onSuccess={fetchAll}
          walletBalances={walletBalances}
        />
      )}
    </div>
  )
}
