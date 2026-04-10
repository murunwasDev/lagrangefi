import { publicClient, createWalletClientForKey } from '../config.js'

type WalletClientWithChain = ReturnType<typeof createWalletClientForKey>

// Uniswap v3 SwapRouter on Arbitrum
const SWAP_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564' as const

const SWAP_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'deadline', type: 'uint256' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const

// sqrtPrice in raw token unit space from a tick: sqrt(1.0001^tick)
function sqrtPriceFromTick(tick: number): number {
  return Math.pow(1.0001, tick / 2)
}

/**
 * Compute the optimal swap to reach the correct token ratio for a Uniswap v3
 * range position. Works in human-readable units (decimal-adjusted) to avoid
 * float precision issues with large raw token amounts.
 *
 * Returns null if no swap is needed (ratio already within 0.1% of target).
 */
export function calculateSwapAmount(params: {
  balance0: bigint
  balance1: bigint
  decimals0: number
  decimals1: number
  sqrtPriceX96: bigint
  newTickLower: number
  newTickUpper: number
  slippageTolerance: number
}): { zeroForOne: boolean; amountIn: bigint; amountOutMinimum: bigint } | null {
  const { balance0, balance1, decimals0, decimals1, sqrtPriceX96, newTickLower, newTickUpper, slippageTolerance } = params

  const sqrtP = Number(sqrtPriceX96) / 2 ** 96
  const sqrtPL = sqrtPriceFromTick(newTickLower)
  const sqrtPU = sqrtPriceFromTick(newTickUpper)

  if (sqrtP <= sqrtPL) {
    // Price is below range — position will be 100% token0. No swap needed.
    return null
  }
  if (sqrtP >= sqrtPU) {
    // Price is above range — position will be 100% token1. No swap needed.
    return null
  }

  // Target ratio in raw units: r = amount1_raw / amount0_raw
  // Derived from Uniswap v3 liquidity formulas:
  //   amount0 = L * (sqrtPU - sqrtP) / (sqrtP * sqrtPU)
  //   amount1 = L * (sqrtP - sqrtPL)
  const r_raw = (sqrtP - sqrtPL) * sqrtP * sqrtPU / (sqrtPU - sqrtP)

  // Convert to human-readable units to avoid float precision loss on large bigints.
  // r_human = r_raw * 10^decimals0 / 10^decimals1
  const decimalAdjust = Math.pow(10, decimals0 - decimals1)
  const r_human = r_raw * decimalAdjust

  // Human-readable balances (small floats, safe from precision loss)
  const b0 = Number(balance0) / Math.pow(10, decimals0)
  const b1 = Number(balance1) / Math.pow(10, decimals1)

  // Human-readable price: token1 per token0 (e.g., USDC per ETH)
  const P_human = sqrtP * sqrtP * decimalAdjust

  if (b0 < 1e-12 && b1 < 1e-12) return null

  // Edge case: only token0
  if (b0 < 1e-12) {
    // Swap half of token1 to token0 as a safe approximation
    const y_human = b1 / 2
    const amountIn = BigInt(Math.floor(y_human * Math.pow(10, decimals1) * 0.999))
    const amountOutMinimum = BigInt(Math.floor((y_human / P_human) * Math.pow(10, decimals0) * (1 - slippageTolerance)))
    return { zeroForOne: false, amountIn, amountOutMinimum }
  }

  // Edge case: only token1
  if (b1 < 1e-12) {
    const x_human = b0 / 2
    const amountIn = BigInt(Math.floor(x_human * Math.pow(10, decimals0) * 0.999))
    const amountOutMinimum = BigInt(Math.floor(x_human * P_human * Math.pow(10, decimals1) * (1 - slippageTolerance)))
    return { zeroForOne: true, amountIn, amountOutMinimum }
  }

  const currentRatio = b1 / b0

  // Within 0.1% of target ratio — no swap needed
  if (Math.abs(currentRatio / r_human - 1) < 0.001) return null

  if (currentRatio < r_human) {
    // Too much token0, not enough token1 → swap token0 → token1
    // x_human = (r_human * b0 - b1) / (r_human + P_human)
    const x_human = (r_human * b0 - b1) / (r_human + P_human)
    if (x_human <= 0) return null
    const amountIn = BigInt(Math.floor(x_human * Math.pow(10, decimals0) * 0.999))
    const amountOutMinimum = BigInt(Math.floor(x_human * P_human * Math.pow(10, decimals1) * (1 - slippageTolerance)))
    return { zeroForOne: true, amountIn, amountOutMinimum }
  } else {
    // Too much token1, not enough token0 → swap token1 → token0
    // y_human = (b1 - r_human * b0) / (1 + r_human / P_human)
    const y_human = (b1 - r_human * b0) / (1 + r_human / P_human)
    if (y_human <= 0) return null
    const amountIn = BigInt(Math.floor(y_human * Math.pow(10, decimals1) * 0.999))
    const amountOutMinimum = BigInt(Math.floor((y_human / P_human) * Math.pow(10, decimals0) * (1 - slippageTolerance)))
    return { zeroForOne: false, amountIn, amountOutMinimum }
  }
}

export async function getTokenDecimals(tokenAddress: `0x${string}`): Promise<number> {
  return await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
  })
}

// keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")
const SWAP_EVENT_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as const

/** Parse Uniswap v3 Pool Swap event from a tx receipt */
export function parseSwapEvent(
  receipt: { logs: ReadonlyArray<{ topics: readonly string[]; data: string }> },
  zeroForOne: boolean,
): { amountOut: bigint; sqrtPriceX96After: bigint } | null {
  const log = receipt.logs.find(l =>
    l.topics[0]?.toLowerCase() === SWAP_EVENT_TOPIC
  )
  if (!log || !log.data || log.data === '0x') return null

  const data = log.data.slice(2)
  if (data.length < 192) return null

  const amount0 = BigInt.asIntN(256, BigInt('0x' + data.slice(0, 64)))
  const amount1 = BigInt.asIntN(256, BigInt('0x' + data.slice(64, 128)))
  const sqrtPriceX96After = BigInt('0x' + data.slice(128, 192))

  const amountOut = zeroForOne ? -amount1 : -amount0
  return { amountOut, sqrtPriceX96After }
}

/**
 * Execute a single-hop swap via Uniswap v3 SwapRouter.
 * Approves the router, swaps, and returns the tx hash plus swap event data.
 */
export async function executeSwap(params: {
  tokenIn: `0x${string}`
  tokenOut: `0x${string}`
  fee: number
  amountIn: bigint
  amountOutMinimum: bigint
  deadline: bigint
  walletClient: WalletClientWithChain
  zeroForOne: boolean
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
}): Promise<{ txHash: `0x${string}`; amountOut: bigint; sqrtPriceX96After: bigint }> {
  const { walletClient, maxFeePerGas, maxPriorityFeePerGas } = params
  const account = walletClient.account!

  // Approve SwapRouter to spend tokenIn
  const approveTx = await walletClient.writeContract({
    address: params.tokenIn,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [SWAP_ROUTER, params.amountIn],
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  await publicClient.waitForTransactionReceipt({ hash: approveTx })

  const swapTx = await walletClient.writeContract({
    address: SWAP_ROUTER,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      fee: params.fee,
      recipient: account.address,
      deadline: params.deadline,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapTx })
  const swapEvent = parseSwapEvent(swapReceipt, params.zeroForOne)

  return {
    txHash: swapTx,
    amountOut: swapEvent?.amountOut ?? 0n,
    sqrtPriceX96After: swapEvent?.sqrtPriceX96After ?? 0n,
  }
}
