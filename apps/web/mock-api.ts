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
  token0: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
  token1: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
  fee: 500,
  tickLower: -201400,
  tickUpper: -199400,
  liquidity: '1500000000000000000',
  tokensOwed0: '620000000000000',   // ~0.00062 WETH unclaimed
  tokensOwed1: '1840000',           // ~1.84 USDC unclaimed
  amount0: '310000000000000000',    // ~0.31 WETH in position
  amount1: '565000000',             // ~565 USDC in position
}

const MOCK_POOL_STATE = {
  sqrtPriceX96: '1771595571142957166518320255467520',
  tick: -200420,
  price: '2843.50',
  decimals0: 18,
  decimals1: 6,
}

const now = Date.now()
const DAY = 24 * 3600 * 1000

const MOCK_STRATEGIES = [
  // Active strategy
  {
    id: 1,
    userId: 1,
    name: 'ETH/USDC 0.05%',
    currentTokenId: '123456',
    token0: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
    token1: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    fee: 500,
    token0Decimals: 18,
    token1Decimals: 6,
    rangePercent: 10,
    slippageTolerance: 0.5,
    pollIntervalSeconds: 60,
    status: 'active',
    createdAt: new Date(now - 14 * DAY).toISOString(),
    stoppedAt: null,
    initialToken0Amount: '350000000000000000',  // 0.35 WETH
    initialToken1Amount: '500000000',            // 500 USDC
    initialValueUsd: 1480.50,                    // 0.35 * 2801.43 + 500
    openEthPriceUsd: 2801.43,
    openTxHashes: JSON.stringify([
      '0xopen1aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444',
      '0xopen2bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555',
    ]),
  },
  // Stopped strategy
  {
    id: 2,
    userId: 1,
    name: 'ETH/USDC 0.30%',
    currentTokenId: '99001',
    token0: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
    token1: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    fee: 3000,
    token0Decimals: 18,
    token1Decimals: 6,
    rangePercent: 20,
    slippageTolerance: 1.0,
    pollIntervalSeconds: 120,
    status: 'stopped',
    createdAt: new Date(now - 45 * DAY).toISOString(),
    stoppedAt: new Date(now - 5 * DAY).toISOString(),
    initialToken0Amount: '500000000000000000',  // 0.5 WETH
    initialToken1Amount: '800000000',            // 800 USDC
    initialValueUsd: 2150.00,                    // 0.5 * 2700 + 800
    openEthPriceUsd: 2700.00,
    openTxHashes: JSON.stringify([
      '0xoldopen1aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc3334',
      '0xoldopen2bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd4445',
    ]),
  },
]

const MOCK_STATS: Record<number, object> = {
  1: {
    strategyId: 1,
    totalRebalances: 8,
    feesCollectedToken0: '9840000000000000',  // ~0.00984 WETH
    feesCollectedToken1: '29520000',           // ~29.52 USDC
    gasCostWei: '18400000000000000',           // ~0.0184 ETH
    gasCostUsd: 52.27,
    feesCollectedUsd: 57.74,
    closeEthPriceUsd: null,
    closeFeesUsd: null,
    closeGasUsd: null,
    closeToken0Amount: null,
    closeToken1Amount: null,
    closeValueUsd: null,
    closeTxHashes: null,
    totalPollTicks: 20160,
    inRangeTicks: 16531,
    timeInRangePct: 82.0,
    avgRebalanceIntervalHours: 41.0,
    updatedAt: new Date().toISOString(),
  },
  2: {
    strategyId: 2,
    totalRebalances: 12,
    feesCollectedToken0: '18200000000000000',  // ~0.0182 WETH
    feesCollectedToken1: '54600000',            // ~54.60 USDC
    gasCostWei: '31200000000000000',            // ~0.0312 ETH
    gasCostUsd: 84.24,
    feesCollectedUsd: 103.54,
    closeEthPriceUsd: 2820.00,
    closeFeesUsd: 103.54,
    closeGasUsd: 84.24,
    closeToken0Amount: '468000000000000000',   // 0.468 WETH withdrawn
    closeToken1Amount: '785000000',             // 785 USDC withdrawn
    closeValueUsd: 2104.76,                     // 0.468 * 2820 + 785
    closeTxHashes: JSON.stringify([
      '0xclose1ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff6',
      '0xclose2ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa1',
    ]),
    totalPollTicks: 51840,
    inRangeTicks: 37325,
    timeInRangePct: 72.0,
    avgRebalanceIntervalHours: 70.0,
    updatedAt: new Date(now - 5 * DAY).toISOString(),
  },
}

// Rebalances for active strategy (id=1)
const MOCK_REBALANCES_1 = [
  {
    id: 8, strategyId: 1, tokenId: '123456', status: 'success',
    newTickLower: -201400, newTickUpper: -199400, newTokenId: '123456',
    txHashes: JSON.stringify([
      '0xr8tx1aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd4',
      '0xr8tx2bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee5',
      '0xr8tx3ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff6',
      '0xr8tx4ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa1',
    ]),
    txSteps: JSON.stringify(['Collect Fees', 'Remove Liquidity', 'Swap', 'Mint Position']),
    feesCollectedToken0: '1420000000000000',  // ~0.00142 WETH
    feesCollectedToken1: '4260000',            // ~4.26 USDC
    gasCostWei: '2300000000000000',
    positionToken0Start: '312000000000000000', positionToken1Start: '568000000',
    positionToken0End:   '310000000000000000', positionToken1End:   '565000000',
    ethPriceUsd: '2843.50',
    errorMessage: null,
    triggeredAt: new Date(now - 2 * 3600 * 1000).toISOString(),
    completedAt: new Date(now - 2 * 3600 * 1000 + 28000).toISOString(),
  },
  {
    id: 7, strategyId: 1, tokenId: '123456', status: 'success',
    newTickLower: -201800, newTickUpper: -199800, newTokenId: '123456',
    txHashes: JSON.stringify([
      '0xr7tx1eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa111bbb2',
      '0xr7tx2fff666aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc3',
      '0xr7tx3aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd4',
      '0xr7tx4bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee5',
    ]),
    txSteps: JSON.stringify(['Collect Fees', 'Remove Liquidity', 'Swap', 'Mint Position']),
    feesCollectedToken0: '1180000000000000',
    feesCollectedToken1: '3540000',
    gasCostWei: '2450000000000000',
    positionToken0Start: '318000000000000000', positionToken1Start: '552000000',
    positionToken0End:   '312000000000000000', positionToken1End:   '568000000',
    ethPriceUsd: '2810.00',
    errorMessage: null,
    triggeredAt: new Date(now - 44 * 3600 * 1000).toISOString(),
    completedAt: new Date(now - 44 * 3600 * 1000 + 35000).toISOString(),
  },
  {
    id: 6, strategyId: 1, tokenId: '123455', status: 'success',
    newTickLower: -201200, newTickUpper: -199200, newTokenId: '123456',
    txHashes: JSON.stringify([
      '0xr6tx1ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff6',
      '0xr6tx2ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa1',
      '0xr6tx3eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa111bbb2',
      '0xr6tx4fff666aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc3',
    ]),
    txSteps: JSON.stringify(['Collect Fees', 'Remove Liquidity', 'Swap', 'Mint Position']),
    feesCollectedToken0: '1350000000000000',
    feesCollectedToken1: '4050000',
    gasCostWei: '2200000000000000',
    positionToken0Start: '325000000000000000', positionToken1Start: '535000000',
    positionToken0End:   '318000000000000000', positionToken1End:   '552000000',
    ethPriceUsd: '2760.00',
    errorMessage: null,
    triggeredAt: new Date(now - 5 * DAY).toISOString(),
    completedAt: new Date(now - 5 * DAY + 32000).toISOString(),
  },
  {
    id: 5, strategyId: 1, tokenId: '123454', status: 'failed',
    newTickLower: null, newTickUpper: null, newTokenId: null,
    txHashes: null, txSteps: null,
    feesCollectedToken0: null, feesCollectedToken1: null,
    gasCostWei: '850000000000000',
    positionToken0Start: '330000000000000000', positionToken1Start: '520000000',
    positionToken0End: null, positionToken1End: null,
    ethPriceUsd: '2720.00',
    errorMessage: 'slippage exceeded: got 2.8% but max was 0.5%',
    triggeredAt: new Date(now - 7 * DAY).toISOString(),
    completedAt: new Date(now - 7 * DAY + 8000).toISOString(),
  },
  {
    id: 4, strategyId: 1, tokenId: '123454', status: 'success',
    newTickLower: -202000, newTickUpper: -200000, newTokenId: '123454',
    txHashes: JSON.stringify([
      '0xr4tx1aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd4',
      '0xr4tx2bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee5',
      '0xr4tx3ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff6',
      '0xr4tx4ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa1',
    ]),
    txSteps: JSON.stringify(['Collect Fees', 'Remove Liquidity', 'Swap', 'Mint Position']),
    feesCollectedToken0: '1290000000000000',
    feesCollectedToken1: '3870000',
    gasCostWei: '2350000000000000',
    positionToken0Start: '340000000000000000', positionToken1Start: '505000000',
    positionToken0End:   '330000000000000000', positionToken1End:   '520000000',
    ethPriceUsd: '2690.00',
    errorMessage: null,
    triggeredAt: new Date(now - 9 * DAY).toISOString(),
    completedAt: new Date(now - 9 * DAY + 41000).toISOString(),
  },
  {
    id: 3, strategyId: 1, tokenId: '123453', status: 'success',
    newTickLower: -201600, newTickUpper: -199600, newTokenId: '123454',
    txHashes: JSON.stringify([
      '0xr3tx1eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa111bbb2',
      '0xr3tx2fff666aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc3',
      '0xr3tx3aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd4',
      '0xr3tx4bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee5',
    ]),
    txSteps: JSON.stringify(['Collect Fees', 'Remove Liquidity', 'Swap', 'Mint Position']),
    feesCollectedToken0: '1640000000000000',
    feesCollectedToken1: '4920000',
    gasCostWei: '2600000000000000',
    positionToken0Start: '352000000000000000', positionToken1Start: '485000000',
    positionToken0End:   '340000000000000000', positionToken1End:   '505000000',
    ethPriceUsd: '2830.00',
    errorMessage: null,
    triggeredAt: new Date(now - 11 * DAY).toISOString(),
    completedAt: new Date(now - 11 * DAY + 38000).toISOString(),
  },
  {
    id: 2, strategyId: 1, tokenId: '123452', status: 'success',
    newTickLower: -201400, newTickUpper: -199400, newTokenId: '123453',
    txHashes: JSON.stringify([
      '0xr2tx1ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff6',
      '0xr2tx2ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa1',
      '0xr2tx3eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa111bbb2',
      '0xr2tx4fff666aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc3',
    ]),
    txSteps: JSON.stringify(['Collect Fees', 'Remove Liquidity', 'Swap', 'Mint Position']),
    feesCollectedToken0: '1520000000000000',
    feesCollectedToken1: '4560000',
    gasCostWei: '2100000000000000',
    positionToken0Start: '360000000000000000', positionToken1Start: '470000000',
    positionToken0End:   '352000000000000000', positionToken1End:   '485000000',
    ethPriceUsd: '2815.00',
    errorMessage: null,
    triggeredAt: new Date(now - 13 * DAY).toISOString(),
    completedAt: new Date(now - 13 * DAY + 30000).toISOString(),
  },
  {
    id: 1, strategyId: 1, tokenId: '123451', status: 'success',
    newTickLower: -201200, newTickUpper: -199200, newTokenId: '123452',
    txHashes: JSON.stringify([
      '0xr1tx1aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd4',
      '0xr1tx2bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee5',
      '0xr1tx3ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff6',
      '0xr1tx4ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa1',
    ]),
    txSteps: JSON.stringify(['Collect Fees', 'Remove Liquidity', 'Swap', 'Mint Position']),
    feesCollectedToken0: '1440000000000000',
    feesCollectedToken1: '4320000',
    gasCostWei: '2400000000000000',
    positionToken0Start: '350000000000000000', positionToken1Start: '500000000',
    positionToken0End:   '360000000000000000', positionToken1End:   '470000000',
    ethPriceUsd: '2801.43',
    errorMessage: null,
    triggeredAt: new Date(now - 13.5 * DAY).toISOString(),
    completedAt: new Date(now - 13.5 * DAY + 45000).toISOString(),
  },
]

// Rebalances for stopped strategy (id=2) — abbreviated for brevity
const MOCK_REBALANCES_2 = [
  {
    id: 20, strategyId: 2, tokenId: '99001', status: 'success',
    newTickLower: -200800, newTickUpper: -197200, newTokenId: '99001',
    txHashes: JSON.stringify([
      '0xs20tx1aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333dd',
      '0xs20tx2bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444ee',
      '0xs20tx3ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555ff',
      '0xs20tx4ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff666aa',
    ]),
    txSteps: JSON.stringify(['Collect Fees', 'Remove Liquidity', 'Swap', 'Mint Position']),
    feesCollectedToken0: '2100000000000000',
    feesCollectedToken1: '6300000',
    gasCostWei: '2800000000000000',
    positionToken0Start: '490000000000000000', positionToken1Start: '795000000',
    positionToken0End:   '480000000000000000', positionToken1End:   '800000000',
    ethPriceUsd: '2790.00',
    errorMessage: null,
    triggeredAt: new Date(now - 8 * DAY).toISOString(),
    completedAt: new Date(now - 8 * DAY + 40000).toISOString(),
  },
  {
    id: 19, strategyId: 2, tokenId: '99000', status: 'success',
    newTickLower: -201200, newTickUpper: -197600, newTokenId: '99001',
    txHashes: JSON.stringify([
      '0xs19tx1eee555fff666aaa111bbb222ccc333ddd444eee555fff666aaa111bb',
      '0xs19tx2fff666aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222cc',
      '0xs19tx3aaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333dd',
      '0xs19tx4bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444ee',
    ]),
    txSteps: JSON.stringify(['Collect Fees', 'Remove Liquidity', 'Swap', 'Mint Position']),
    feesCollectedToken0: '1950000000000000',
    feesCollectedToken1: '5850000',
    gasCostWei: '2650000000000000',
    positionToken0Start: '498000000000000000', positionToken1Start: '780000000',
    positionToken0End:   '490000000000000000', positionToken1End:   '795000000',
    ethPriceUsd: '2750.00',
    errorMessage: null,
    triggeredAt: new Date(now - 14 * DAY).toISOString(),
    completedAt: new Date(now - 14 * DAY + 36000).toISOString(),
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
        if (url === '/me/wallet/balances') return json(res, { address: '0xdeadbeef00000000000000000000000000000001', eth: '0.35', usdc: '500.00' })

        if (url === '/api/v1/strategies' && method === 'GET') return json(res, MOCK_STRATEGIES)
        if (url === '/api/v1/strategies' && method === 'POST') return json(res, MOCK_STRATEGIES[0])
        if (url === '/api/v1/strategies/start' && method === 'POST') return json(res, {
          tokenId: '789012',
          txHashes: [
            '0xaaa111bbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee5',
            '0xbbb222ccc333ddd444eee555fff666aaa111bbb222ccc333ddd444eee555fff6',
          ],
        })

        const statsMatch = url.match(/^\/api\/v1\/strategies\/(\d+)\/stats$/)
        if (statsMatch) return json(res, MOCK_STATS[parseInt(statsMatch[1])] ?? MOCK_STATS[1])

        const rebalancesMatch = url.match(/^\/api\/v1\/strategies\/(\d+)\/rebalances$/)
        if (rebalancesMatch) {
          const id = parseInt(rebalancesMatch[1])
          return json(res, id === 2 ? MOCK_REBALANCES_2 : MOCK_REBALANCES_1)
        }

        if (url.match(/^\/api\/v1\/strategies\/\d+\/pause$/) && method === 'PATCH') return json(res, {})
        if (url.match(/^\/api\/v1\/strategies\/\d+\/resume$/) && method === 'PATCH') return json(res, {})
        if (url.match(/^\/api\/v1\/strategies\/\d+$/) && method === 'DELETE') return json(res, {})

        const strategyMatch = url.match(/^\/api\/v1\/strategies\/(\d+)$/)
        if (strategyMatch && method === 'GET') {
          const id = parseInt(strategyMatch[1])
          return json(res, MOCK_STRATEGIES.find(s => s.id === id) ?? MOCK_STRATEGIES[0])
        }

        if (url === '/api/v1/position') return json(res, MOCK_POSITION)
        if (url === '/api/v1/pool-state') return json(res, MOCK_POOL_STATE)
        if (url === '/api/v1/rebalances') return json(res, MOCK_REBALANCES_1)

        next()
      })
    },
  }
}
