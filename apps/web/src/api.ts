import type {
  Position, PoolState, Strategy, StrategyStats,
  StrategyEvent, User, CreateStrategyRequest,
} from './types'
import {
  MOCK_MODE, MOCK_TOKEN, MOCK_USER, MOCK_STRATEGIES, MOCK_STATS,
  MOCK_POSITION, MOCK_POOL_STATE, MOCK_REBALANCES, MOCK_WALLET_BALANCES,
} from './mockData'

const TOKEN_KEY = 'lagrangefi_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function apiFetch<T>(path: string, options?: RequestInit & { noRedirect?: boolean }): Promise<T> {
  const { noRedirect, ...fetchOptions } = options ?? {}
  const res = await fetch(path, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(fetchOptions?.headers ?? {}),
    },
  })
  if (res.status === 401) {
    if (!noRedirect) {
      clearToken()
      window.location.href = '/login'
    }
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? 'Invalid credentials')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

// --- Auth ---

export async function register(username: string, password: string): Promise<{ token: string; userId: number; username: string }> {
  if (MOCK_MODE) return { token: MOCK_TOKEN, userId: MOCK_USER.userId, username }
  return apiFetch('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    noRedirect: true,
  })
}

export async function login(username: string, password: string): Promise<{ token: string; userId: number; username: string }> {
  if (MOCK_MODE) return { token: MOCK_TOKEN, userId: MOCK_USER.userId, username }
  return apiFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    noRedirect: true,
  })
}

export async function fetchMe(): Promise<User> {
  if (MOCK_MODE) return MOCK_USER
  return apiFetch('/me')
}

// --- Wallet ---

export async function fetchWalletStatus(): Promise<{ hasWallet: boolean }> {
  if (MOCK_MODE) return { hasWallet: true }
  return apiFetch('/me/wallet')
}

export async function fetchWalletBalances(): Promise<{ address: string; eth: string; usdc: string }> {
  if (MOCK_MODE) return MOCK_WALLET_BALANCES
  return apiFetch('/me/wallet/balances')
}

export async function saveWallet(phrase: string): Promise<void> {
  if (MOCK_MODE) return
  await apiFetch('/me/wallet', {
    method: 'PUT',
    body: JSON.stringify({ phrase }),
  })
}

// --- Strategies ---

export async function fetchStrategies(): Promise<Strategy[]> {
  if (MOCK_MODE) return MOCK_STRATEGIES
  return apiFetch('/api/v1/strategies')
}

export interface StartStrategyRequest {
  name: string
  ethAmount: string
  usdcAmount: string
  feeTier: number
  rangePercent: number
  slippageTolerance: number
  pollIntervalSeconds: number
}

export async function startStrategy(req: StartStrategyRequest): Promise<{ tokenId: string; txHashes: string[] }> {
  return apiFetch('/api/v1/strategies/start', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export async function createStrategy(req: CreateStrategyRequest): Promise<Strategy> {
  return apiFetch('/api/v1/strategies', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export async function pauseStrategy(id: number): Promise<void> {
  if (MOCK_MODE) return
  await apiFetch(`/api/v1/strategies/${id}/pause`, { method: 'PATCH' })
}

export async function resumeStrategy(id: number): Promise<void> {
  if (MOCK_MODE) return
  await apiFetch(`/api/v1/strategies/${id}/resume`, { method: 'PATCH' })
}

export async function stopStrategy(id: number): Promise<void> {
  if (MOCK_MODE) return
  await apiFetch(`/api/v1/strategies/${id}`, { method: 'DELETE' })
}

export async function fetchStrategyStats(id: number): Promise<StrategyStats> {
  if (MOCK_MODE) return MOCK_STATS[id] ?? MOCK_STATS[1]
  return apiFetch(`/api/v1/strategies/${id}/stats`)
}

export async function fetchStrategyRebalances(id: number): Promise<StrategyEvent[]> {
  if (MOCK_MODE) return MOCK_REBALANCES[id] ?? []
  return apiFetch(`/api/v1/strategies/${id}/rebalances`)
}

// --- Position / Pool (active strategy) ---

export async function fetchPosition(): Promise<Position> {
  if (MOCK_MODE) return MOCK_POSITION
  return apiFetch('/api/v1/position')
}

export async function fetchPoolState(): Promise<PoolState> {
  if (MOCK_MODE) return MOCK_POOL_STATE
  return apiFetch('/api/v1/pool-state')
}

export async function fetchRebalances(): Promise<StrategyEvent[]> {
  if (MOCK_MODE) return MOCK_REBALANCES[1] ?? []
  return apiFetch('/api/v1/rebalances')
}
