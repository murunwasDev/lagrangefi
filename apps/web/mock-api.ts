import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

const MOCK_USER = { userId: 1, username: 'demo', hasWallet: true }

const MOCK_POSITION = {
  tokenId: '123456',
  owner: '0xdeadbeef00000000000000000000000000000001',
  token0: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH (lower address = token0)
  token1: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
  fee: 500,
  tickLower: -201400,
  tickUpper: -199400,
  liquidity: '1500000000000000000',
}

const MOCK_POOL_STATE = {
  sqrtPriceX96: '1771595571142957166518320255467520',
  tick: -200420,
  price: '2843.50',
  decimals0: 18, // WETH
  decimals1: 6,  // USDC
}

const MOCK_STRATEGIES = [
  {
    id: 1,
    userId: 1,
    name: 'ETH/USDC 0.05%',
    currentTokenId: '123456',
    token0: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH (lower address = token0)
    token1: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    fee: 500,
    token0Decimals: 18,
    token1Decimals: 6,
    rangePercent: 10,
    slippageTolerance: 0.5,
    pollIntervalSeconds: 60,
    status: 'active',
    createdAt: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
    stoppedAt: null,
    initialToken0Amount: '250000000000000000',  // 0.25 WETH
    initialToken1Amount: '500000000',           // 500 USDC
    initialValueUsd: 1355.88,                   // 0.25 * 2823.50 + 500
  },
]

const MOCK_STATS = {
  strategyId: 1,
  totalRebalances: 5,
  feesCollectedToken0: '4320000000000000', // WETH (18 decimals) ~0.00432 WETH
  feesCollectedToken1: '12340000',          // USDC (6 decimals)  ~12.34 USDC
  gasCostWei: '8200000000000000',
  gasCostUsd: 27.83, // ~0.0082 ETH * ~$3400
  feesCollectedUsd: 29.18,
  closeEthPriceUsd: null,
  closeFeesUsd: null,
  closeGasUsd: null,
  totalPollTicks: 1200,
  inRangeTicks: 980,
  timeInRangePct: 81.67,
  avgRebalanceIntervalHours: 33.6,
  updatedAt: new Date().toISOString(),
}

const MOCK_REBALANCES = [
  {
    id: 3, strategyId: 1, tokenId: '123456', status: 'success',
    newTickLower: -201400, newTickUpper: -199400, newTokenId: '123456',
    txHashes: JSON.stringify(['0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1']),
    feesCollectedToken0: '4100000', feesCollectedToken1: '1440000000000000',
    gasCostWei: '2700000000000000',
    // ~0.25 WETH + 710 USDC before, ~0.248 WETH + 705 USDC after (some lost to gas/slippage)
    positionToken0Start: '250000000000000000', positionToken1Start: '710000000',
    positionToken0End:   '248000000000000000', positionToken1End:   '705000000',
    ethPriceUsd: '3425.50',
    errorMessage: null,
    triggeredAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    completedAt: new Date(Date.now() - 2 * 3600 * 1000 + 30000).toISOString(),
  },
  {
    id: 2, strategyId: 1, tokenId: '123455', status: 'success',
    newTickLower: -202000, newTickUpper: -200000, newTokenId: '123456',
    txHashes: JSON.stringify(['0xdef789abc012def789abc012def789abc012def789abc012def789abc012def7']),
    feesCollectedToken0: '5120000', feesCollectedToken1: '1800000000000000',
    gasCostWei: '2900000000000000',
    positionToken0Start: '252000000000000000', positionToken1Start: '715000000',
    positionToken0End:   '250000000000000000', positionToken1End:   '710000000',
    ethPriceUsd: '3380.00',
    errorMessage: null,
    triggeredAt: new Date(Date.now() - 26 * 3600 * 1000).toISOString(),
    completedAt: new Date(Date.now() - 26 * 3600 * 1000 + 45000).toISOString(),
  },
  {
    id: 1, strategyId: 1, tokenId: '123454', status: 'failed',
    newTickLower: null, newTickUpper: null, newTokenId: null,
    txHashes: null, feesCollectedToken0: null, feesCollectedToken1: null,
    gasCostWei: null,
    positionToken0Start: null, positionToken1Start: null,
    positionToken0End: null, positionToken1End: null,
    ethPriceUsd: null,
    errorMessage: 'slippage exceeded',
    triggeredAt: new Date(Date.now() - 50 * 3600 * 1000).toISOString(),
    completedAt: new Date(Date.now() - 50 * 3600 * 1000 + 5000).toISOString(),
  },
]

export function mockApiPlugin(): Plugin {
  return {
    name: 'mock-api',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next) => {
        const url = req.url ?? ''
        const method = req.method ?? 'GET'

        if (url === '/auth/login' && method === 'POST') return json(res, { token: 'mock-token', ...MOCK_USER })
        if (url === '/auth/register' && method === 'POST') return json(res, { token: 'mock-token', ...MOCK_USER })
        if (url === '/me') return json(res, MOCK_USER)
        if (url === '/me/wallet' && method === 'GET') return json(res, { hasWallet: true })
        if (url === '/me/wallet' && method === 'PUT') return json(res, {})
        if (url === '/me/wallet/balances') return json(res, { address: '0xdeadbeef00000000000000000000000000000001', eth: '0.25', usdc: '500.00' })

        if (url === '/api/v1/strategies' && method === 'GET') return json(res, MOCK_STRATEGIES)
        if (url === '/api/v1/strategies' && method === 'POST') return json(res, MOCK_STRATEGIES[0])
        if (url === '/api/v1/strategies/start' && method === 'POST') return json(res, {
          tokenId: '789012',
          txHashes: [
            '0xaaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee5',
            '0xbbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff6',
            '0xccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa1',
          ],
        })
        if (url.match(/^\/api\/v1\/strategies\/\d+\/stats$/)) return json(res, MOCK_STATS)
        if (url.match(/^\/api\/v1\/strategies\/\d+\/rebalances$/)) return json(res, MOCK_REBALANCES)
        if (url.match(/^\/api\/v1\/strategies\/\d+\/pause$/) && method === 'PATCH') return json(res, {})
        if (url.match(/^\/api\/v1\/strategies\/\d+\/resume$/) && method === 'PATCH') return json(res, {})
        if (url.match(/^\/api\/v1\/strategies\/\d+$/) && method === 'DELETE') return json(res, {})
        if (url.match(/^\/api\/v1\/strategies\/\d+$/) && method === 'GET') return json(res, MOCK_STRATEGIES[0])

        if (url === '/api/v1/position') return json(res, MOCK_POSITION)
        if (url === '/api/v1/pool-state') return json(res, MOCK_POOL_STATE)
        if (url === '/api/v1/rebalances') return json(res, MOCK_REBALANCES)

        next()
      })
    },
  }
}
