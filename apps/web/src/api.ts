import type { Position, PoolState, RebalanceEvent } from './types'

const MOCK: {
  position: Position
  poolState: PoolState
  rebalances: RebalanceEvent[]
} = {
  position: {
    tokenId: '12345',
    token0: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
    token1: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    fee: 500,
    tickLower: 192180,
    tickUpper: 198420,
    liquidity: '8234719283471928',
  },
  poolState: {
    sqrtPriceX96: '1234567890123456789012345678',
    tick: 195300,
    price: '3421.58',
  },
  rebalances: [
    {
      id: 1,
      tokenId: '12344',
      status: 'success',
      newTickLower: 192180,
      newTickUpper: 198420,
      newTokenId: '12345',
      txHashes: '["0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1","0xdef456abc123def456abc123def456abc123def456abc123def456abc123def4"]',
      errorMessage: null,
      triggeredAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 3 * 60 * 60 * 1000 + 45000).toISOString(),
    },
    {
      id: 2,
      tokenId: '12343',
      status: 'failed',
      newTickLower: 191000,
      newTickUpper: 197200,
      newTokenId: null,
      txHashes: null,
      errorMessage: 'Slippage exceeded: price moved 1.2% during swap',
      triggeredAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 26 * 60 * 60 * 1000 + 12000).toISOString(),
    },
    {
      id: 3,
      tokenId: '12342',
      status: 'success',
      newTickLower: 190500,
      newTickUpper: 196700,
      newTokenId: '12343',
      txHashes: '["0x111aaa222bbb333ccc444ddd555eee666fff777aaa888bbb999ccc000ddd111e"]',
      errorMessage: null,
      triggeredAt: new Date(Date.now() - 51 * 60 * 60 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 51 * 60 * 60 * 1000 + 38000).toISOString(),
    },
  ],
}

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

async function mockFetch<T>(data: T): Promise<T> {
  await new Promise(r => setTimeout(r, 300)) // simulate network
  return data
}

export async function fetchPosition(): Promise<Position> {
  if (USE_MOCK) return mockFetch(MOCK.position)
  return fetch('/api/v1/position').then(r => r.json())
}

export async function fetchPoolState(): Promise<PoolState> {
  if (USE_MOCK) return mockFetch(MOCK.poolState)
  return fetch('/api/v1/pool-state').then(r => r.json())
}

export async function fetchRebalances(): Promise<RebalanceEvent[]> {
  if (USE_MOCK) return mockFetch(MOCK.rebalances)
  return fetch('/api/v1/rebalances').then(r => r.json())
}
