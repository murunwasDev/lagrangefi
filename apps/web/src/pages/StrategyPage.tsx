import { useState, useEffect, useRef, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  fetchStrategies, startStrategy, createStrategy,
  pauseStrategy, resumeStrategy, stopStrategy,
  fetchStrategyStats, fetchStrategyRebalances, fetchWalletBalances,
} from '../api'
import type { Strategy, StrategyStats, RebalanceEvent } from '../types'

interface WalletBalances { address: string; eth: string; usdc: string }

const FEE_TIERS = [
  { value: 100, label: '0.01%' },
  { value: 500, label: '0.05%' },
  { value: 3000, label: '0.30%' },
  { value: 10000, label: '1.00%' },
]

const TOKEN_LABELS: Record<string, string> = {
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e',
}
function tokenLabel(addr: string) {
  return TOKEN_LABELS[addr.toLowerCase()] ?? addr.slice(0, 6) + '...' + addr.slice(-4)
}
function feeLabel(fee: number) {
  return (fee / 10000).toFixed(2) + '%'
}
function shortHash(h: string) {
  return h.slice(0, 8) + '...' + h.slice(-6)
}
function weiToEth(wei: string): string {
  const n = BigInt(wei)
  const eth = Number(n) / 1e18
  return eth.toFixed(6)
}
function formatRawAmount(amount: string, decimals: number): string {
  const n = BigInt(amount)
  const d = 10n ** BigInt(decimals)
  const whole = n / d
  const frac = n % d
  return `${whole}.${frac.toString().padStart(decimals, '0').slice(0, 4)}`
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-emerald-500/20 text-emerald-400 ring-emerald-500/30',
    paused: 'bg-yellow-500/20 text-yellow-400 ring-yellow-500/30',
    stopped: 'bg-slate-500/20 text-slate-400 ring-slate-500/30',
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ring-1 ${styles[status] ?? styles.stopped}`}>
      {status === 'active' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
      {status}
    </span>
  )
}

function StatsCard({ stats, token0, token1 }: { stats: StrategyStats; token0: string; token1: string }) {
  const t0Label = tokenLabel(token0)
  const t1Label = tokenLabel(token1)
  // USDC has 6 decimals, WETH 18 — heuristic: if "USDC" in label use 6 else 18
  const dec0 = t0Label.includes('USDC') ? 6 : 18
  const dec1 = t1Label.includes('USDC') ? 6 : 18

  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5 space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">Analytics</h3>
      <Row label="Rebalances" value={stats.totalRebalances} />
      <Row label="Time in range" value={`${stats.timeInRangePct.toFixed(1)}%`} />
      <Row label={`Fees (${t0Label})`} value={formatRawAmount(stats.feesCollectedToken0, dec0)} />
      <Row label={`Fees (${t1Label})`} value={formatRawAmount(stats.feesCollectedToken1, dec1)} />
      <Row label="Gas spent (ETH)" value={weiToEth(stats.gasCostWei)} />
      <Row
        label="Avg rebalance interval"
        value={stats.avgRebalanceIntervalHours != null ? `${stats.avgRebalanceIntervalHours.toFixed(1)}h` : '—'}
      />
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-1 border-b border-slate-700/40 last:border-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-sm font-mono text-slate-200">{value}</span>
    </div>
  )
}

function RebalanceTable({ events }: { events: RebalanceEvent[] }) {
  if (events.length === 0) return <p className="text-slate-500 text-sm py-4 text-center">No rebalances yet</p>

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-700">
            <th className="text-left pb-2 font-medium">Time</th>
            <th className="text-left pb-2 font-medium">Status</th>
            <th className="text-left pb-2 font-medium">New Range</th>
            <th className="text-left pb-2 font-medium">Fees (t0/t1)</th>
            <th className="text-left pb-2 font-medium">Tx</th>
          </tr>
        </thead>
        <tbody>
          {events.map(r => (
            <tr key={r.id} className="border-b border-slate-700/40 last:border-0">
              <td className="py-2 text-slate-400 font-mono text-xs">{new Date(r.triggeredAt).toLocaleString()}</td>
              <td className="py-2">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  r.status === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
                  r.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                  'bg-yellow-500/20 text-yellow-400'
                }`}>{r.status}</span>
              </td>
              <td className="py-2 text-slate-300 font-mono text-xs">
                {r.newTickLower != null ? `${r.newTickLower} → ${r.newTickUpper}` : '—'}
              </td>
              <td className="py-2 text-slate-400 font-mono text-xs">
                {r.feesCollectedToken0 != null ? `${r.feesCollectedToken0} / ${r.feesCollectedToken1}` : '—'}
              </td>
              <td className="py-2 text-slate-400 font-mono text-xs">
                {r.txHashes
                  ? JSON.parse(r.txHashes).slice(0, 1).map((h: string) => (
                      <a key={h} href={`https://arbiscan.io/tx/${h}`} target="_blank" rel="noopener noreferrer"
                         className="text-blue-400 hover:text-blue-300 underline">{shortHash(h)}</a>
                    ))
                  : r.errorMessage ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function StrategyPage() {
  const navigate = useNavigate()
  const [strategies, setStrategies] = useState<Strategy[]>([])
  const [stats, setStats] = useState<Record<number, StrategyStats>>({})
  const [rebalances, setRebalances] = useState<Record<number, RebalanceEvent[]>>({})
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [walletBalances, setWalletBalances] = useState<WalletBalances | null>(null)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [createMode, setCreateMode] = useState<'mint' | 'register'>('mint')
  const [formState, setFormState] = useState<'form' | 'submitting' | 'success' | 'error'>('form')
  // mint mode fields
  const [createName, setCreateName] = useState('')
  const [ethAmount, setEthAmount] = useState('')
  const [usdcAmount, setUsdcAmount] = useState('')
  const [feeTier, setFeeTier] = useState(500)
  // register mode fields
  const [createTokenId, setCreateTokenId] = useState('')
  // shared
  const [createRange, setCreateRange] = useState(5)
  const [createSlippage, setCreateSlippage] = useState('0.5')
  const [createInterval, setCreateInterval] = useState('60')
  const [createError, setCreateError] = useState<string | null>(null)
  const [successData, setSuccessData] = useState<{ tokenId: string; txHashes: string[] } | null>(null)
  const balancesLoadedRef = useRef(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    try {
      const list = await fetchStrategies()
      setStrategies(list)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load strategies')
    }
  }

  async function loadBalances() {
    if (balancesLoadedRef.current) return
    balancesLoadedRef.current = true
    try {
      const b = await fetchWalletBalances()
      setWalletBalances(b)
    } catch {
      // balances are optional — ignore errors
    }
  }

  function openCreate() {
    setShowCreate(true)
    setFormState('form')
    setCreateError(null)
    setSuccessData(null)
    loadBalances()
  }

  function closeCreate() {
    setShowCreate(false)
    setFormState('form')
    setCreateError(null)
    setSuccessData(null)
  }

  async function expandStrategy(id: number, _token0: string, _token1: string) {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    const [s, r] = await Promise.all([
      fetchStrategyStats(id),
      fetchStrategyRebalances(id),
    ])
    setStats(prev => ({ ...prev, [id]: s }))
    setRebalances(prev => ({ ...prev, [id]: r }))
  }

  async function handlePause(id: number) {
    await pauseStrategy(id)
    load()
  }

  async function handleResume(id: number) {
    try {
      await resumeStrategy(id)
      load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to resume')
    }
  }

  async function handleStop(id: number) {
    if (!confirm('Stop this strategy permanently?')) return
    await stopStrategy(id)
    setExpandedId(null)
    load()
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setCreateError(null)
    setFormState('submitting')
    try {
      if (createMode === 'mint') {
        const result = await startStrategy({
          name: createName,
          ethAmount,
          usdcAmount,
          feeTier,
          rangePercent: createRange / 100,
          slippageTolerance: parseFloat(createSlippage) / 100,
          pollIntervalSeconds: parseInt(createInterval, 10),
        })
        setSuccessData(result)
        setFormState('success')
        balancesLoadedRef.current = false
        load()
      } else {
        await createStrategy({
          name: createName,
          tokenId: createTokenId,
          rangePercent: createRange / 100,
          slippageTolerance: parseFloat(createSlippage) / 100,
          pollIntervalSeconds: parseInt(createInterval, 10),
        })
        closeCreate()
        balancesLoadedRef.current = false
        load()
      }
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create strategy')
      setFormState('error')
    }
  }

  const hasActive = strategies.some(s => s.status === 'active')

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-white">Strategies</h1>
        {!hasActive && (
          <button
            onClick={openCreate}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            New strategy
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {showCreate && (
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 mb-6">

          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-base font-semibold text-white">New strategy</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {createMode === 'mint' ? 'Create a new WETH/USDC position and start auto-rebalancing' : 'Register an existing Uniswap v3 position'}
              </p>
            </div>
            {formState !== 'submitting' && (
              <button type="button" onClick={closeCreate} className="text-slate-400 hover:text-slate-200 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* Success state */}
          {formState === 'success' && successData && (
            <div className="text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto">
                <svg className="w-7 h-7 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-white font-semibold">Strategy started!</p>
                <p className="text-slate-400 text-sm mt-1">
                  Position <span className="text-white font-mono">#{successData.tokenId}</span> is now active and will auto-rebalance.
                </p>
              </div>
              {successData.txHashes.length > 0 && (
                <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-3 text-left space-y-1.5">
                  <p className="text-xs text-slate-500 uppercase tracking-wider font-medium mb-2">Transactions</p>
                  {successData.txHashes.map((h, i) => (
                    <div key={h} className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">{['Wrap', 'Swap', 'Mint'][i] ?? `Tx ${i + 1}`}</span>
                      <a href={`https://arbiscan.io/tx/${h}`} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-blue-400 hover:text-blue-300 font-mono underline">
                        {h.slice(0, 8)}…{h.slice(-6)}
                      </a>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={closeCreate}
                className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl transition-colors text-sm">
                Done
              </button>
            </div>
          )}

          {/* Submitting state */}
          {formState === 'submitting' && (
            <div className="text-center space-y-4 py-6">
              <svg className="w-10 h-10 text-blue-400 animate-spin mx-auto" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              <div>
                <p className="text-white font-medium">Creating position on-chain…</p>
                <p className="text-slate-400 text-xs mt-1">This may take 1–2 minutes. Do not close this page.</p>
              </div>
            </div>
          )}

          {/* Form state (and error retry) */}
          {(formState === 'form' || formState === 'error') && (
            <form onSubmit={handleCreate} className="space-y-5">

              {/* Mode toggle */}
              <div className="flex gap-1 bg-slate-900/50 rounded-lg p-1">
                <button type="button" onClick={() => setCreateMode('mint')}
                  className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${createMode === 'mint' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                  Create new position
                </button>
                <button type="button" onClick={() => setCreateMode('register')}
                  className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${createMode === 'register' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                  Register existing
                </button>
              </div>

              {/* Wallet balances */}
              {walletBalances && (
                <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg px-4 py-3 flex items-center gap-6">
                  <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">Wallet</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-slate-400">ETH</span>
                    <span className="text-sm font-mono text-white">{Number(walletBalances.eth).toFixed(4)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-slate-400">USDC</span>
                    <span className="text-sm font-mono text-white">{Number(walletBalances.usdc).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                  </div>
                  <span className="text-xs text-slate-600 font-mono ml-auto">
                    {walletBalances.address.slice(0, 6)}…{walletBalances.address.slice(-4)}
                  </span>
                </div>
              )}

              {createError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-3 py-2">{createError}</div>
              )}

              {/* Strategy name */}
              <div>
                <label className="block text-xs text-slate-400 mb-1">Strategy name</label>
                <input
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
                  value={createName} onChange={e => setCreateName(e.target.value)} placeholder="My ETH/USDC strategy" required
                />
              </div>

              {createMode === 'mint' ? (
                <>
                  {/* ETH + USDC amounts */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex justify-between items-baseline mb-1.5">
                        <label className="text-xs font-medium text-slate-400">ETH amount</label>
                        {walletBalances && (
                          <button type="button" onClick={() => setEthAmount(walletBalances.eth)}
                            className="text-xs text-blue-400 hover:text-blue-300 font-mono">
                            Max {Number(walletBalances.eth).toFixed(4)}
                          </button>
                        )}
                      </div>
                      <div className="relative">
                        <input type="number" min="0" step="0.001" placeholder="0.0" value={ethAmount}
                          onChange={e => setEthAmount(e.target.value)}
                          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 pr-12" />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-medium">ETH</span>
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between items-baseline mb-1.5">
                        <label className="text-xs font-medium text-slate-400">USDC amount</label>
                        {walletBalances && (
                          <button type="button" onClick={() => setUsdcAmount(Number(walletBalances.usdc).toFixed(2))}
                            className="text-xs text-blue-400 hover:text-blue-300 font-mono">
                            Max {Number(walletBalances.usdc).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                          </button>
                        )}
                      </div>
                      <div className="relative">
                        <input type="number" min="0" step="1" placeholder="0.0" value={usdcAmount}
                          onChange={e => setUsdcAmount(e.target.value)}
                          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 pr-14" />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-medium">USDC</span>
                      </div>
                    </div>
                  </div>

                  {/* Fee tier */}
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">Fee tier</label>
                    <div className="grid grid-cols-4 gap-2">
                      {FEE_TIERS.map(ft => (
                        <button key={ft.value} type="button" onClick={() => setFeeTier(ft.value)}
                          className={`py-2 rounded-lg text-xs font-medium border transition-colors ${
                            feeTier === ft.value
                              ? 'bg-blue-600 border-blue-500 text-white'
                              : 'bg-slate-800 border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-300'
                          }`}>
                          {ft.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                /* Register mode: token ID */
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Position token ID (NFT)</label>
                  <input
                    className="w-full bg-slate-700/50 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 font-mono focus:outline-none focus:border-blue-500 transition-colors"
                    value={createTokenId} onChange={e => setCreateTokenId(e.target.value)} placeholder="123456" required={createMode === 'register'}
                  />
                </div>
              )}

              {/* Range slider */}
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  {createMode === 'mint' ? 'Price range' : 'Rebalance trigger range'} — <span className="text-white font-medium">±{createRange}%</span> from current price
                </label>
                <input type="range" min="1" max="20" step="1" value={createRange}
                  onChange={e => setCreateRange(Number(e.target.value))}
                  className="w-full accent-blue-500" />
                <div className="flex justify-between text-xs text-slate-500 mt-1">
                  <span>1% (tight)</span>
                  <span>20% (wide)</span>
                </div>
              </div>

              {/* Advanced: slippage + poll interval */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Slippage (%)</label>
                  <input className="w-full bg-slate-700/50 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                    type="number" step="0.01" min="0.01" max="5" value={createSlippage}
                    onChange={e => setCreateSlippage(e.target.value)} required />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Poll interval (s)</label>
                  <input className="w-full bg-slate-700/50 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                    type="number" min="30" max="3600" value={createInterval}
                    onChange={e => setCreateInterval(e.target.value)} required />
                </div>
              </div>

              {/* Summary */}
              <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-4 space-y-2">
                <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">Summary</p>
                {createMode === 'mint' ? (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Deposit</span>
                      <span className="text-slate-300 font-mono">{ethAmount || '0'} ETH + {usdcAmount || '0'} USDC</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Pool</span>
                      <span className="text-slate-300">WETH / USDC · {FEE_TIERS.find(f => f.value === feeTier)?.label}</span>
                    </div>
                  </>
                ) : (
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Position NFT</span>
                    <span className="text-slate-300 font-mono">#{createTokenId || '—'}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Range</span>
                  <span className="text-slate-300">±{createRange}% around current price</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Auto-rebalance</span>
                  <span className="text-emerald-400">Enabled</span>
                </div>
              </div>

              <div className="flex gap-2">
                <button type="submit"
                  className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors">
                  {createMode === 'mint' ? 'Start strategy' : 'Register strategy'}
                </button>
                <button type="button" onClick={closeCreate}
                  className="text-slate-400 hover:text-white text-sm px-4 py-2 rounded-lg border border-slate-700 transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {strategies.length === 0 ? (
        <div className="text-center py-16 text-slate-500 text-sm">
          No strategies yet.{' '}
          <button className="text-blue-400 hover:text-blue-300" onClick={() => navigate('/wallet')}>
            Configure a wallet first
          </button>{' '}
          then create one.
        </div>
      ) : (
        <div className="space-y-4">
          {strategies.map(s => (
            <div key={s.id} className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden">
              {/* Strategy header */}
              <div
                className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-slate-700/20 transition-colors"
                onClick={() => expandStrategy(s.id, s.token0, s.token1)}
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={s.status} />
                  <span className="font-medium text-white">{s.name}</span>
                  <span className="text-xs text-slate-400 font-mono">
                    {tokenLabel(s.token0)}/{tokenLabel(s.token1)} · {feeLabel(s.fee)} · #{s.currentTokenId}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {s.status === 'active' && (
                    <button onClick={e => { e.stopPropagation(); handlePause(s.id) }}
                      className="text-xs text-yellow-400 hover:text-yellow-300 px-2 py-1 rounded border border-yellow-500/30 hover:border-yellow-400/50 transition-colors">
                      Pause
                    </button>
                  )}
                  {s.status === 'paused' && (
                    <button onClick={e => { e.stopPropagation(); handleResume(s.id) }}
                      className="text-xs text-emerald-400 hover:text-emerald-300 px-2 py-1 rounded border border-emerald-500/30 hover:border-emerald-400/50 transition-colors">
                      Resume
                    </button>
                  )}
                  {s.status !== 'stopped' && (
                    <button onClick={e => { e.stopPropagation(); handleStop(s.id) }}
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-500/30 hover:border-red-400/50 transition-colors">
                      Stop
                    </button>
                  )}
                  <span className="text-slate-500 text-sm">{expandedId === s.id ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Expanded detail */}
              {expandedId === s.id && (
                <div className="border-t border-slate-700/50 px-5 py-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5 space-y-2">
                      <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">Config</h3>
                      <Row label="Range" value={`± ${(s.rangePercent * 100).toFixed(1)}%`} />
                      <Row label="Slippage" value={`${(s.slippageTolerance * 100).toFixed(2)}%`} />
                      <Row label="Poll interval" value={`${s.pollIntervalSeconds}s`} />
                      <Row label="Started" value={new Date(s.createdAt).toLocaleDateString()} />
                      {s.stoppedAt && <Row label="Stopped" value={new Date(s.stoppedAt).toLocaleDateString()} />}
                    </div>

                    {stats[s.id] ? (
                      <StatsCard stats={stats[s.id]} token0={s.token0} token1={s.token1} />
                    ) : (
                      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5 flex items-center justify-center text-slate-500 text-sm">
                        Loading stats...
                      </div>
                    )}
                  </div>

                  <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5">
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-4">Rebalance History</h3>
                    {rebalances[s.id] ? (
                      <RebalanceTable events={rebalances[s.id]} />
                    ) : (
                      <p className="text-slate-500 text-sm text-center py-4">Loading...</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
