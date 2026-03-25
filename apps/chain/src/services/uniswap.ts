import { publicClient } from '../config.js'
import { getTokenDecimals } from './swap.js'
import type { Position, PoolState } from '@lagrangefi/shared'

// Uniswap v3 NonfungiblePositionManager on Arbitrum
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' as const

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

export async function getPosition(tokenId: bigint): Promise<Position> {
  const result = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'positions',
    args: [tokenId],
  })

  return {
    tokenId: tokenId.toString(),
    owner: '', // fetched separately if needed
    token0: result[2],
    token1: result[3],
    fee: result[4],
    tickLower: result[5],
    tickUpper: result[6],
    liquidity: result[7].toString(),
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
