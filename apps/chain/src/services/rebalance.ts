import { createWalletClientForKey, publicClient } from '../config.js'
import { calculateSwapAmount, executeSwap, getTokenDecimals } from './swap.js'
import type { RebalanceRequest, RebalanceResult, FeesCollected } from '@lagrangefi/shared'

// Uniswap v3 NonfungiblePositionManager on Arbitrum
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' as const

const POSITION_MANAGER_ABI = [
  {
    name: 'decreaseLiquidity',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'liquidity', type: 'uint128' },
        { name: 'amount0Min', type: 'uint256' },
        { name: 'amount1Min', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    }],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    name: 'collect',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'recipient', type: 'address' },
        { name: 'amount0Max', type: 'uint128' },
        { name: 'amount1Max', type: 'uint128' },
      ],
    }],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'token0', type: 'address' },
        { name: 'token1', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'tickLower', type: 'int24' },
        { name: 'tickUpper', type: 'int24' },
        { name: 'amount0Desired', type: 'uint256' },
        { name: 'amount1Desired', type: 'uint256' },
        { name: 'amount0Min', type: 'uint256' },
        { name: 'amount1Min', type: 'uint256' },
        { name: 'recipient', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    }],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
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

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// keccak256("Collect(uint256,address,uint256,uint256)")
const COLLECT_EVENT_TOPIC = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3afa95c9f56a5c71bf52e133e41' as const

const MAX_UINT128 = 2n ** 128n - 1n
const DEADLINE_BUFFER = 300n // 5 minutes

/** Sum gasUsed * effectiveGasPrice across all receipts, return total wei as bigint */
function totalGasWei(receipts: Array<{ gasUsed: bigint; effectiveGasPrice: bigint }>): bigint {
  return receipts.reduce((acc, r) => acc + r.gasUsed * r.effectiveGasPrice, 0n)
}

/** Parse Collect event from receipt to extract total collected amounts (fees + principal) */
function parseTotalCollected(
  receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>
): { amount0: bigint; amount1: bigint } | undefined {
  const log = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === POSITION_MANAGER.toLowerCase() &&
      l.topics[0]?.toLowerCase() === COLLECT_EVENT_TOPIC.toLowerCase()
  )
  if (!log || !log.data || log.data === '0x') return undefined

  // Collect event data layout (recipient is NOT indexed):
  //   [0:32]   recipient address (padded to 32 bytes)
  //   [32:64]  amount0Collect (uint256)
  //   [64:96]  amount1Collect (uint256)
  const data = log.data.slice(2) // remove 0x
  if (data.length < 192) return undefined
  const amount0 = BigInt('0x' + data.slice(64, 128))   // skip recipient (32 bytes = 64 hex chars)
  const amount1 = BigInt('0x' + data.slice(128, 192))
  return { amount0, amount1 }
}

export async function rebalance(req: RebalanceRequest): Promise<RebalanceResult> {
  const walletClient = createWalletClientForKey(req.walletPrivateKey)
  const tokenId = BigInt(req.tokenId)
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_BUFFER
  const account = walletClient.account!
  const txHashes: string[] = []
  const receipts: Array<{ gasUsed: bigint; effectiveGasPrice: bigint }> = []

  // 1. Fetch current position
  const position = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'positions',
    args: [tokenId],
  })
  const liquidity = position[7]

  if (liquidity === 0n) {
    return { success: false, txHashes: [], error: 'Position has no liquidity' }
  }

  // 2. Simulate decreaseLiquidity first to capture principal amounts (fees = total_collected - principal)
  const decreaseParams = {
    tokenId,
    liquidity,
    amount0Min: 0n,
    amount1Min: 0n,
    deadline,
  }
  let principal0 = 0n
  let principal1 = 0n
  try {
    const sim = await publicClient.simulateContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'decreaseLiquidity',
      account: account.address,
      args: [decreaseParams],
    })
    principal0 = sim.result[0]
    principal1 = sim.result[1]
  } catch {
    // If simulation fails, fees will be 0 (conservative fallback — principal unknown)
  }

  // Remove all liquidity
  const decreaseTx = await walletClient.writeContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'decreaseLiquidity',
    args: [decreaseParams],
  })
  const decreaseReceipt = await publicClient.waitForTransactionReceipt({ hash: decreaseTx })
  txHashes.push(decreaseTx)
  receipts.push(decreaseReceipt)

  // From this point on, liquidity has been removed from the pool and tokens are owed to this
  // position in the NonfungiblePositionManager. If anything below fails, we must collect those
  // tokens back to the wallet so they are never left stranded in the contract.
  try {

  // 3. Collect all tokens (includes accrued LP fees + withdrawn liquidity)
  const collectTx = await walletClient.writeContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'collect',
    args: [{
      tokenId,
      recipient: account.address,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    }],
  })
  const collectReceipt = await publicClient.waitForTransactionReceipt({ hash: collectTx })
  txHashes.push(collectTx)
  receipts.push(collectReceipt)

  // Parse total collected from Collect event, then subtract principal to get LP fees only
  const totalCollected = parseTotalCollected(collectReceipt)
  const feesCollected: FeesCollected | undefined = totalCollected
    ? {
        amount0: (totalCollected.amount0 > principal0 ? totalCollected.amount0 - principal0 : 0n).toString(),
        amount1: (totalCollected.amount1 > principal1 ? totalCollected.amount1 - principal1 : 0n).toString(),
      }
    : undefined

  // 4. Extract position token addresses and fee
  const token0 = position[2] as `0x${string}`
  const token1 = position[3] as `0x${string}`
  const fee = position[4]

  // 5. Get token decimals and pool state
  const [decimals0, decimals1, poolState] = await Promise.all([
    getTokenDecimals(token0),
    getTokenDecimals(token1),
    publicClient.readContract({
      address: await publicClient.readContract({
        address: '0x1F98431c8aD98523631AE4a59f267346ea31F984' as const,
        abi: [{
          name: 'getPool', type: 'function', stateMutability: 'view',
          inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }],
          outputs: [{ name: 'pool', type: 'address' }],
        }] as const,
        functionName: 'getPool',
        args: [token0, token1, fee],
      }),
      abi: [{
        name: 'slot0', type: 'function', stateMutability: 'view',
        inputs: [],
        outputs: [
          { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
          { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
          { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
          { name: 'unlocked', type: 'bool' },
        ],
      }] as const,
      functionName: 'slot0',
    }),
  ])

  // 6. Fetch balances after collection — this is the start position value (liquidity + fees)
  const [balance0, balance1] = await Promise.all([
    publicClient.readContract({ address: token0, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: token1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])
  const positionToken0Start = balance0.toString()
  const positionToken1Start = balance1.toString()

  const swap = calculateSwapAmount({
    balance0,
    balance1,
    decimals0,
    decimals1,
    sqrtPriceX96: poolState[0],
    newTickLower: req.newTickLower,
    newTickUpper: req.newTickUpper,
    slippageTolerance: req.slippageTolerance,
  })

  if (swap !== null) {
    const [tokenIn, tokenOut] = swap.zeroForOne ? [token0, token1] : [token1, token0]
    const swapTx = await executeSwap({
      tokenIn,
      tokenOut,
      fee,
      amountIn: swap.amountIn,
      amountOutMinimum: swap.amountOutMinimum,
      deadline,
      walletClient,
    })
    const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapTx })
    txHashes.push(swapTx)
    receipts.push(swapReceipt)
  }

  // Re-fetch balances after the swap
  const [finalBalance0, finalBalance1] = await Promise.all([
    publicClient.readContract({ address: token0, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: token1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])

  // 8. Approve position manager to spend final token balances — sequential to avoid nonce collision
  const approveTx0 = await walletClient.writeContract({ address: token0, abi: ERC20_ABI, functionName: 'approve', args: [POSITION_MANAGER, finalBalance0] })
  const approveReceipt0 = await publicClient.waitForTransactionReceipt({ hash: approveTx0 })
  const approveTx1 = await walletClient.writeContract({ address: token1, abi: ERC20_ABI, functionName: 'approve', args: [POSITION_MANAGER, finalBalance1] })
  const approveReceipt1 = await publicClient.waitForTransactionReceipt({ hash: approveTx1 })
  txHashes.push(approveTx0, approveTx1)
  receipts.push(approveReceipt0, approveReceipt1)

  // 9. Mint new position at new range
  const mintTx = await walletClient.writeContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'mint',
    args: [{
      token0,
      token1,
      fee,
      tickLower: req.newTickLower,
      tickUpper: req.newTickUpper,
      amount0Desired: finalBalance0,
      amount1Desired: finalBalance1,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: account.address,
      deadline,
    }],
  })
  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintTx })
  txHashes.push(mintTx)
  receipts.push(mintReceipt)

  // Parse new tokenId from Transfer event (ERC721 topic[3] = tokenId)
  const transferLog = mintReceipt.logs.find(
    (log) =>
      log.address.toLowerCase() === POSITION_MANAGER.toLowerCase() &&
      log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  )
  const newTokenId = transferLog?.topics[3] ? BigInt(transferLog.topics[3]).toString() : undefined

  // Parse IncreaseLiquidity event to get actual amounts deposited into new position
  // keccak256("IncreaseLiquidity(uint256,uint128,uint256,uint256)")
  const INCREASE_LIQUIDITY_TOPIC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f'
  const mintLog = mintReceipt.logs.find(
    (log) =>
      log.address.toLowerCase() === POSITION_MANAGER.toLowerCase() &&
      log.topics[0]?.toLowerCase() === INCREASE_LIQUIDITY_TOPIC.toLowerCase()
  )
  let positionToken0End: string | undefined
  let positionToken1End: string | undefined
  if (mintLog?.data && mintLog.data !== '0x') {
    const data = mintLog.data.slice(2)
    // IncreaseLiquidity(tokenId, liquidity, amount0, amount1) — liquidity in topics[2], amounts in data
    positionToken0End = BigInt('0x' + data.slice(0, 64)).toString()
    positionToken1End = BigInt('0x' + data.slice(64, 128)).toString()
  }

  const gasUsedWei = totalGasWei(receipts).toString()

  return { success: true, txHashes, newTokenId, feesCollected, gasUsedWei, positionToken0Start, positionToken1Start, positionToken0End, positionToken1End }

  } catch (err) {
    // Recovery: collect tokens back to wallet so they are not stranded in the position manager
    try {
      const recoverTx = await walletClient.writeContract({
        address: POSITION_MANAGER,
        abi: POSITION_MANAGER_ABI,
        functionName: 'collect',
        args: [{
          tokenId,
          recipient: account.address,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        }],
      })
      await publicClient.waitForTransactionReceipt({ hash: recoverTx })
      txHashes.push(recoverTx)
    } catch (collectErr) {
      // Recovery failed — include both errors in the response
      const msg = err instanceof Error ? err.message : String(err)
      const collectMsg = collectErr instanceof Error ? collectErr.message : String(collectErr)
      return { success: false, txHashes, error: `${msg}; recovery collect also failed: ${collectMsg}` }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, txHashes, error: `${msg}; tokens recovered to wallet` }
  }
}
