import { createWalletClientForKey, publicClient } from '../config.js'
import { calculateSwapAmount, executeSwap, getTokenDecimals } from './swap.js'
import type { RebalanceRequest, RebalanceResult, FeesCollected, TxDetail, SwapCost } from '@lagrangefi/shared'

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
    name: 'burn',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
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
const COLLECT_EVENT_TOPIC = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01' as const

const MAX_UINT128 = 2n ** 128n - 1n
const DEADLINE_BUFFER = 300n // 5 minutes

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
  const txDetails: TxDetail[] = []

  // Bug fix: fetch gas price once at the start of the rebalance and apply a 50% buffer.
  // Using per-call auto-estimation caused partial failures when baseFee rose between txs
  // (e.g. collect succeeded but burn was rejected with "maxFeePerGas < baseFee").
  const feeData = await publicClient.estimateFeesPerGas()
  const maxFeePerGas = feeData.maxFeePerGas !== undefined
    ? (feeData.maxFeePerGas * 3n) / 2n   // 50% buffer over estimated max fee
    : undefined
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas

  const trackTx = async (hash: `0x${string}`, action: string) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    txDetails.push({ txHash: hash, action, gasUsedWei: Number(receipt.gasUsed * receipt.effectiveGasPrice) })
    return receipt
  }

  // 1. Fetch current position. If the NFT no longer exists (burned in a prior failed rebalance),
  //    fall through to recovery mode: skip remove/collect/burn and go straight to swap + mint
  //    using the token pair from the request and the current wallet balance.
  let liquidity = 0n
  let tokensOwed0 = 0n
  let tokensOwed1 = 0n
  let token0: `0x${string}`
  let token1: `0x${string}`
  let fee: number
  let positionExists = true

  try {
    const position = await publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'positions',
      args: [tokenId],
    })
    liquidity = position[7]
    tokensOwed0 = position[10]
    tokensOwed1 = position[11]
    token0 = position[2] as `0x${string}`
    token1 = position[3] as `0x${string}`
    fee = position[4]
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes('nonexistent token') && !msg.includes('owner query')) {
      throw e  // unexpected error — propagate
    }
    // Position NFT burned in a previous failed rebalance.
    if (!req.token0 || !req.token1 || req.fee == null) {
      throw new Error(`Position ${req.tokenId} no longer exists and token pair not provided — cannot recover`)
    }
    token0 = req.token0 as `0x${string}`
    token1 = req.token1 as `0x${string}`
    fee = req.fee
    positionExists = false
  }

  // Pending tokens from the previous mint cycle that should be folded into this rebalance
  const pending0 = BigInt(req.pendingToken0 ?? '0')
  const pending1 = BigInt(req.pendingToken1 ?? '0')

  // Snapshot wallet balance before collect so we can isolate true dust
  // (anything in the wallet that is NOT our tracked pending from the last cycle).
  // In recovery mode (positionExists = false) pending already equals the wallet balance
  // that was saved after the failed rebalance, so trueDust will be ~0.
  const [preCollectBalance0, preCollectBalance1] = await Promise.all([
    publicClient.readContract({ address: token0, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: token1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])
  const trueDust0 = preCollectBalance0 > pending0 ? preCollectBalance0 - pending0 : 0n
  const trueDust1 = preCollectBalance1 > pending1 ? preCollectBalance1 - pending1 : 0n

  let principal0 = 0n
  let principal1 = 0n

  if (positionExists && liquidity > 0n) {
    // 2. Simulate decreaseLiquidity first to capture principal amounts (fees = total_collected - principal)
    const decreaseParams = {
      tokenId,
      liquidity,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline,
    }
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
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    const decreaseReceipt = await trackTx(decreaseTx, 'REMOVE_LIQUIDITY')
    if (decreaseReceipt.status === 'reverted') {
      throw new Error(`decreaseLiquidity reverted (tx: ${decreaseTx})`)
    }
  }
  // If positionExists && liquidity === 0: a previous rebalance removed liquidity but failed
  // before minting. Tokens may be stranded as tokensOwed in the position manager, or already
  // in the wallet. Either way, fall through to collect + re-mint.
  // If !positionExists: NFT was burned in a previous failed rebalance — skip straight to mint.

  // From this point on, liquidity has been removed. If anything below fails, we must collect
  // any stranded tokens back to the wallet so they are never left in the contract.
  let feesCollected: FeesCollected | undefined
  let collectedFromPosition: { amount0: bigint; amount1: bigint } | undefined

  try {

  if (positionExists) {
    // 3. Collect tokens if any are owed (LP fees + withdrawn liquidity, or stranded from prior attempt)
    if (liquidity > 0n || tokensOwed0 > 0n || tokensOwed1 > 0n) {
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
        maxFeePerGas,
        maxPriorityFeePerGas,
      })
      const collectReceipt = await trackTx(collectTx, 'COLLECT_FEES')

      // Parse total collected from Collect event, then subtract principal to get LP fees only
      const totalCollected = parseTotalCollected(collectReceipt)
      collectedFromPosition = totalCollected
      feesCollected = totalCollected
        ? {
            amount0: (totalCollected.amount0 > principal0 ? totalCollected.amount0 - principal0 : 0n).toString(),
            amount1: (totalCollected.amount1 > principal1 ? totalCollected.amount1 - principal1 : 0n).toString(),
          }
        : undefined
    }

    // Burn the old NFT now that liquidity and tokens are fully withdrawn.
    // Also burn zombie NFTs (0 liquidity, 0 tokensOwed) left behind by previous failed rebalances.
    const burnTx = await walletClient.writeContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'burn',
      args: [tokenId],
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    await trackTx(burnTx, 'BURN')
  }

  // 4. (token0, token1, fee already extracted above)

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

  // 6. Compute working capital = collected from position + pending from last cycle.
  //    This excludes true wallet dust (anything beyond our tracked pending).
  const totalToUse0 = (collectedFromPosition?.amount0 ?? 0n) + pending0
  const totalToUse1 = (collectedFromPosition?.amount1 ?? 0n) + pending1

  // positionToken0Start = everything entering the new position (collected + pending)
  const positionToken0Start = totalToUse0.toString()
  const positionToken1Start = totalToUse1.toString()

  const swap = calculateSwapAmount({
    balance0: totalToUse0,
    balance1: totalToUse1,
    decimals0,
    decimals1,
    sqrtPriceX96: poolState[0],
    newTickLower: req.newTickLower,
    newTickUpper: req.newTickUpper,
    slippageTolerance: req.slippageTolerance,
  })

  let swapCostResult: SwapCost | undefined
  let sqrtPriceX96AfterSwap: bigint = poolState[0]  // default: pre-swap price if no swap

  if (swap !== null) {
    const [tokenIn, tokenOut] = swap.zeroForOne ? [token0, token1] : [token1, token0]
    const swapResult = await executeSwap({
      tokenIn,
      tokenOut,
      fee,
      amountIn: swap.amountIn,
      amountOutMinimum: swap.amountOutMinimum,
      deadline,
      walletClient,
      zeroForOne: swap.zeroForOne,
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    await trackTx(swapResult.txHash, 'SWAP')

    // Fair amount at pre-swap spot price (no fee, no slippage)
    const sqrtP = Number(poolState[0]) / 2 ** 96
    const fairAmountOut = swap.zeroForOne
      ? BigInt(Math.floor(Number(swap.amountIn) * sqrtP * sqrtP))
      : BigInt(Math.floor(Number(swap.amountIn) / (sqrtP * sqrtP)))

    sqrtPriceX96AfterSwap = swapResult.sqrtPriceX96After

    swapCostResult = {
      amountIn:      swap.amountIn.toString(),
      amountOut:     swapResult.amountOut.toString(),
      fairAmountOut: fairAmountOut.toString(),
      direction:     swap.zeroForOne ? 'zeroForOne' : 'oneForZero',
    }
  }

  // Human-readable prices: token1/token0 (e.g. USDC per WETH = USD price of ETH)
  const decimalAdjust = Math.pow(10, decimals0 - decimals1)
  const sqrtPBefore = Number(poolState[0]) / 2 ** 96
  const priceAtSwap = (sqrtPBefore * sqrtPBefore * decimalAdjust).toFixed(8)
  const sqrtPAfter = Number(sqrtPriceX96AfterSwap) / 2 ** 96
  const priceAtEnd = (sqrtPAfter * sqrtPAfter * decimalAdjust).toFixed(8)

  // Re-fetch balances after the swap, then subtract trueDust to get usable amounts only.
  // trueDust = whatever was in the wallet before we started that isn't our pending capital.
  const [postSwapBalance0, postSwapBalance1] = await Promise.all([
    publicClient.readContract({ address: token0, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: token1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])
  const finalUsable0 = postSwapBalance0 > trueDust0 ? postSwapBalance0 - trueDust0 : 0n
  const finalUsable1 = postSwapBalance1 > trueDust1 ? postSwapBalance1 - trueDust1 : 0n

  // 8. Approve position manager for usable amounts only — sequential to avoid nonce collision
  const approveTx0 = await walletClient.writeContract({ address: token0, abi: ERC20_ABI, functionName: 'approve', args: [POSITION_MANAGER, finalUsable0], maxFeePerGas, maxPriorityFeePerGas })
  await trackTx(approveTx0, 'APPROVE')
  const approveTx1 = await walletClient.writeContract({ address: token1, abi: ERC20_ABI, functionName: 'approve', args: [POSITION_MANAGER, finalUsable1], maxFeePerGas, maxPriorityFeePerGas })
  await trackTx(approveTx1, 'APPROVE')

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
      amount0Desired: finalUsable0,
      amount1Desired: finalUsable1,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: account.address,
      deadline,
    }],
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  const mintReceipt = await trackTx(mintTx, 'MINT')

  if (mintReceipt.status === 'reverted') {
    throw new Error(`mint reverted (tx: ${mintTx})`)
  }

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
    // IncreaseLiquidity data layout: [liquidity(32 bytes)][amount0(32 bytes)][amount1(32 bytes)]
    // tokenId is indexed (in topics[1]), so data starts with liquidity
    positionToken0End = BigInt('0x' + data.slice(64, 128)).toString()   // amount0 (skip liquidity)
    positionToken1End = BigInt('0x' + data.slice(128, 192)).toString()  // amount1
  }

  const txHashes = txDetails.map(d => d.txHash)
  const gasUsedWei = txDetails.reduce((acc, d) => acc + BigInt(d.gasUsedWei), 0n).toString()

  // Compute leftover — tokens that did not fit into the new LP position
  const deposited0 = positionToken0End ? BigInt(positionToken0End) : 0n
  const deposited1 = positionToken1End ? BigInt(positionToken1End) : 0n
  const leftoverToken0 = (finalUsable0 > deposited0 ? finalUsable0 - deposited0 : 0n).toString()
  const leftoverToken1 = (finalUsable1 > deposited1 ? finalUsable1 - deposited1 : 0n).toString()

  const isRecovery = !positionExists || liquidity === 0n
  return { success: true, txHashes, txDetails, newTokenId, feesCollected, gasUsedWei, positionToken0Start, positionToken1Start, positionToken0End, positionToken1End, isRecovery, leftoverToken0, leftoverToken1, swapCost: swapCostResult, priceAtSwap, priceAtEnd }

  } catch (err) {
    // Recovery: collect any tokens still owed in the position back to the wallet so they are
    // never left stranded in the position manager contract.
    const msg = err instanceof Error ? err.message : String(err)
    const gasUsedWei = () => txDetails.reduce((acc, d) => acc + BigInt(d.gasUsedWei), 0n).toString()

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
        maxFeePerGas,
        maxPriorityFeePerGas,
      })
      await trackTx(recoverTx, 'COLLECT_FEES')
      // Recovery collect succeeded — return collected amounts so API saves them as pending.
      return {
        success: false,
        txHashes: txDetails.map(d => d.txHash),
        txDetails,
        error: `${msg}; tokens recovered to wallet`,
        feesCollected,
        gasUsedWei: gasUsedWei(),
        recoveredToken0: collectedFromPosition?.amount0.toString() ?? '0',
        recoveredToken1: collectedFromPosition?.amount1.toString() ?? '0',
      }
    } catch {
      // Recovery collect also failed — the NFT is already burned (swap/mint failure path).
      // The tokens are already in the wallet post-swap. Read the actual wallet balance so the
      // API saves the real current amounts as pending (not the stale pre-swap collected amounts).
      let recoveredToken0 = collectedFromPosition?.amount0.toString() ?? '0'
      let recoveredToken1 = collectedFromPosition?.amount1.toString() ?? '0'
      try {
        const [walBal0, walBal1] = await Promise.all([
          publicClient.readContract({ address: token0, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
          publicClient.readContract({ address: token1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
        ])
        recoveredToken0 = walBal0.toString()
        recoveredToken1 = walBal1.toString()
      } catch {
        // If balance reads fail, fall back to collected amounts — better than nothing
      }
      return {
        success: false,
        txHashes: txDetails.map(d => d.txHash),
        txDetails,
        error: `${msg}; NFT burned — tokens remain in wallet`,
        feesCollected,
        gasUsedWei: gasUsedWei(),
        recoveredToken0,
        recoveredToken1,
      }
    }
  }
}
