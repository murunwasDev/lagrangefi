import { publicClient } from '../config.js'
import { getTokenDecimals } from './swap.js'
import type { Position, PoolState } from '@lagrangefi/shared'

// Uniswap v3 NonfungiblePositionManager on Arbitrum
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' as const

const MAX_UINT128 = BigInt('340282366920938463463374607431768211455')

// Minimal ABI — only what we need
const POSITION_MANAGER_ABI = [
  {
    name: 'positions',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'owner', type: 'address' }],
  },
  {
    name: 'collect',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'recipient', type: 'address' },
          { name: 'amount0Max', type: 'uint128' },
          { name: 'amount1Max', type: 'uint128' },
        ],
      },
    ],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
] as const

const POOL_ABI = [
  {
    name: 'slot0',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const

const FACTORY_ABI = [
  {
    name: 'getPool',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984' as const

/**
 * Compute the token0/token1 amounts held in a Uniswap v3 LP position from its
 * liquidity, tick range, and current pool price. Returns raw token units.
 */
function getPositionAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  currentTick: number,
  liquidity: bigint,
): { amount0: string; amount1: string } {
  if (liquidity === 0n) return { amount0: '0', amount1: '0' }

  const sqrtP = Number(sqrtPriceX96) / 2 ** 96
  const sqrtA = Math.pow(1.0001, tickLower / 2)
  const sqrtB = Math.pow(1.0001, tickUpper / 2)
  const L = Number(liquidity)

  let amount0: number
  let amount1: number

  if (currentTick < tickLower) {
    amount0 = L * (1 / sqrtA - 1 / sqrtB)
    amount1 = 0
  } else if (currentTick >= tickUpper) {
    amount0 = 0
    amount1 = L * (sqrtB - sqrtA)
  } else {
    amount0 = L * (1 / sqrtP - 1 / sqrtB)
    amount1 = L * (sqrtP - sqrtA)
  }

  return {
    amount0: BigInt(Math.round(Math.max(0, amount0))).toString(),
    amount1: BigInt(Math.round(Math.max(0, amount1))).toString(),
  }
}

export async function getPosition(tokenId: bigint): Promise<Position> {
  const [result, owner] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'positions',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    }),
  ])

  const token0 = result[2] as `0x${string}`
  const token1 = result[3] as `0x${string}`
  const fee = result[4]
  const tickLower = result[5]
  const tickUpper = result[6]
  const liquidity = result[7]

  // Simulate collect() to get actual unclaimed fees including pending accrued fees.
  // Also fetch pool state to compute LP principal amounts from liquidity.
  let tokensOwed0 = result[10]
  let tokensOwed1 = result[11]
  let amount0: string | undefined
  let amount1: string | undefined

  const [poolAddress] = await Promise.all([
    publicClient.readContract({
      address: FACTORY,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [token0, token1, fee],
    }),
    (async () => {
      try {
        const { result: collected } = await publicClient.simulateContract({
          address: POSITION_MANAGER,
          abi: POSITION_MANAGER_ABI,
          functionName: 'collect',
          args: [{ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
          account: owner,
        })
        tokensOwed0 = collected[0]
        tokensOwed1 = collected[1]
      } catch {
        // fall back to checkpointed values if simulation fails
      }
    })(),
  ])

  try {
    const slot0 = await publicClient.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: 'slot0',
    })
    const computed = getPositionAmounts(slot0[0], tickLower, tickUpper, slot0[1], liquidity)
    amount0 = computed.amount0
    amount1 = computed.amount1
  } catch {
    // non-fatal: amounts remain undefined, UI falls back to last rebalance positionToken0End
  }

  return {
    tokenId: tokenId.toString(),
    owner,
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    liquidity: liquidity.toString(),
    tokensOwed0: tokensOwed0.toString(),
    tokensOwed1: tokensOwed1.toString(),
    amount0,
    amount1,
  }
}

export async function getPoolState(tokenId: bigint): Promise<PoolState> {
  const position = await getPosition(tokenId)
  return getPoolStateByPair(position.token0 as `0x${string}`, position.token1 as `0x${string}`, position.fee)
}

export async function getPoolStateByPair(
  token0: `0x${string}`,
  token1: `0x${string}`,
  fee: number,
): Promise<PoolState> {
  const [poolAddress, decimals0, decimals1] = await Promise.all([
    publicClient.readContract({
      address: FACTORY,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [token0, token1, fee],
    }),
    getTokenDecimals(token0),
    getTokenDecimals(token1),
  ])

  const slot0 = await publicClient.readContract({
    address: poolAddress,
    abi: POOL_ABI,
    functionName: 'slot0',
  })

  const sqrtPriceX96 = slot0[0]
  const tick = slot0[1]

  // price_raw = (sqrtPriceX96 / 2^96)^2  →  human price = price_raw * 10^(decimals0 - decimals1)
  // e.g. for WETH(18)/USDC(6): price_raw * 10^12 gives USDC per WETH
  const rawPrice = (Number(sqrtPriceX96) / 2 ** 96) ** 2
  const price = rawPrice * Math.pow(10, decimals0 - decimals1)

  return {
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick,
    price: price.toFixed(2),
    decimals0,
    decimals1,
  }
}

export function isOutOfRange(tick: number, tickLower: number, tickUpper: number): boolean {
  return tick < tickLower || tick >= tickUpper
}
