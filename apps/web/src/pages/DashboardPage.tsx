import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Position, PoolState, RebalanceEvent } from '../types'
import { fetchPosition, fetchPoolState, fetchRebalances } from '../api'

const TOKEN_LABELS: Record<string, string> = {
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e',
}
function tokenLabel(address: string) {
  return TOKEN_LABELS[address.toLowerCase()] ?? address.slice(0, 6) + '...' + address.slice(-4)
}
function feeLabel(fee: number) {
  return (fee / 10000).toFixed(2) + '%'
}
function shortHash(hash: string) {
  return hash.slice(0, 8) + '...' + hash.slice(-6)
}

function PriceRangeBar({ tick, tickLower, tickUpper }: { tick: number; tickLower: number; tickUpper: number }) {
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
        <span>Tick {tickLower}</span>
        <span>Current: {tick}</span>
        <span>Tick {tickUpper}</span>
      </div>
      <div className="relative h-4 bg-slate-700 rounded-full overflow-visible">
        <div className={`absolute h-full rounded-full ${inRange ? 'bg-emerald-500/40' : 'bg-red-500/30'}`}
          style={{ left: `${lowerPct}%`, width: `${upperPct - lowerPct}%` }} />
        <div className={`absolute top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-full ${inRange ? 'bg-emerald-400' : 'bg-red-400'}`}
          style={{ left: `${currentPct}%` }} />
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

export default function DashboardPage() {
  const [position, setPosition] = useState<Position | null>(null)
  const [poolState, setPoolState] = useState<PoolState | null>(null)
  const [rebalances, setRebalances] = useState<RebalanceEvent[]>([])
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function fetchAll() {
    try {
      const [pos, pool, rebal] = await Promise.all([
        fetchPosition(),
        fetchPoolState(),
        fetchRebalances(),
      ])
      setPosition(pos)
      setPoolState(pool)
      setRebalances(rebal)
      setLastUpdated(new Date())
      setError(null)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch data'
      if (msg !== 'Unauthorized') setError(msg)
    }
  }

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, 30_000)
    return () => clearInterval(interval)
  }, [])

  const inRange = poolState && position
    ? poolState.tick >= position.tickLower && poolState.tick < position.tickUpper
    : null

  if (error?.includes('No active strategy')) {
    return (
      <div className="text-center py-16">
        <p className="text-slate-400 text-sm mb-4">No active strategy found.</p>
        <Link to="/strategies" className="text-blue-400 hover:text-blue-300 text-sm underline">
          Create a strategy →
        </Link>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Dashboard</h1>
          <p className="text-sm text-slate-400 mt-0.5">Active strategy · Uniswap v3 · Arbitrum</p>
        </div>
        <div className="text-right">
          {inRange !== null && <StatusBadge inRange={inRange} />}
          {lastUpdated && <p className="text-xs text-slate-500 mt-1">Updated {lastUpdated.toLocaleTimeString()}</p>}
        </div>
      </div>

      {error && (
        <div className="mb-6 bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <Card title="Position">
          {position ? (
            <>
              <Row label="Token ID" value={`#${position.tokenId}`} />
              <Row label="Pair" value={`${tokenLabel(position.token0)} / ${tokenLabel(position.token1)}`} />
              <Row label="Fee Tier" value={feeLabel(position.fee)} />
              <Row label="Tick Range" value={`${position.tickLower} → ${position.tickUpper}`} />
              <Row label="Liquidity" value={BigInt(position.liquidity) > 0n ? '✓ Active' : '— Empty'} />
            </>
          ) : (
            <p className="text-slate-500 text-sm">Loading...</p>
          )}
        </Card>

        <Card title="Pool State">
          {poolState ? (
            <>
              <Row label="Price (USDC/WETH)" value={`$${Number(poolState.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}`} />
              <Row label="Current Tick" value={poolState.tick} />
              <Row label="Status" value={inRange !== null ? <StatusBadge inRange={inRange} /> : '—'} />
            </>
          ) : (
            <p className="text-slate-500 text-sm">Loading...</p>
          )}
          {poolState && position && (
            <PriceRangeBar tick={poolState.tick} tickLower={position.tickLower} tickUpper={position.tickUpper} />
          )}
        </Card>
      </div>

      <Card title="Recent Rebalances">
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
                {rebalances.slice(0, 10).map(r => (
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
        )}
      </Card>
    </div>
  )
}
