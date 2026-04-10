import { parseEther, parseUnits } from 'viem'
import { createWalletClientForKey, publicClient } from '../config.js'
import { calculateSwapAmount, executeSwap, getTokenDecimals } from './swap.js'
import { getPoolStateByPair } from './uniswap.js'
import type { MintRequest, MintResult, TxDetail } from '@lagrangefi/shared'

const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' as const
const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' as const
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831' as const

// token0 < token1 by address: WETH (0x82..) < USDC (0xaf..)
const TOKEN0 = WETH
const TOKEN1 = USDC

const WETH_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
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
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

const POSITION_MANAGER_ABI = [
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
] as const

const DEADLINE_BUFFER = 300n

export async function mintPosition(req: MintRequest): Promise<MintResult> {
  const walletClient = createWalletClientForKey(req.walletPrivateKey)
  const account = walletClient.account!
  const txDetails: TxDetail[] = []
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_BUFFER

  const trackTx = async (hash: `0x${string}`, action: string) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    txDetails.push({ txHash: hash, action, gasUsedWei: Number(receipt.gasUsed * receipt.effectiveGasPrice) })
    return receipt
  }

  // 1. Snapshot pre-existing balances before any operations so we never touch
  //    funds that belong to other strategies or pre-existing wallet dust.
  const [prevBalance0, prevBalance1] = await Promise.all([
    publicClient.readContract({ address: TOKEN0, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: TOKEN1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])

  // 2. Wrap ETH → WETH if requested
  const ethAmt = parseFloat(req.ethAmount)
  if (!isNaN(ethAmt) && ethAmt > 0) {
    const wrapTx = await walletClient.writeContract({
      address: WETH,
      abi: WETH_ABI,
      functionName: 'deposit',
      value: parseEther(req.ethAmount),
    })
    await trackTx(wrapTx, 'WRAP')
  }

  // 3. Get pool state for swap calculation
  const poolState = await getPoolStateByPair(TOKEN0, TOKEN1, req.feeTier)
  const sqrtPriceX96 = BigInt(poolState.sqrtPriceX96)

  // 4. Fetch token decimals
  const [decimals0, decimals1] = await Promise.all([
    getTokenDecimals(TOKEN0),
    getTokenDecimals(TOKEN1),
  ])

  // 5. Calculate and execute optimal swap using only the intended deposit amounts,
  //    not the full wallet balance — so pre-existing funds are never touched.
  const intended0 = parseEther(req.ethAmount)
  const intended1 = parseUnits(req.usdcAmount, decimals1)

  const swap = calculateSwapAmount({
    balance0: intended0,
    balance1: intended1,
    decimals0,
    decimals1,
    sqrtPriceX96,
    newTickLower: req.tickLower,
    newTickUpper: req.tickUpper,
    slippageTolerance: req.slippageTolerance,
  })

  if (swap !== null) {
    const [tokenIn, tokenOut] = swap.zeroForOne ? [TOKEN0, TOKEN1] : [TOKEN1, TOKEN0]
    const swapResult = await executeSwap({
      tokenIn,
      tokenOut,
      fee: req.feeTier,
      amountIn: swap.amountIn,
      amountOutMinimum: swap.amountOutMinimum,
      deadline,
      walletClient,
      zeroForOne: swap.zeroForOne,
    })
    await trackTx(swapResult.txHash, 'SWAP')
  }

  // 6. Re-fetch balances and compute only "our" amounts (intended ± swap delta).
  //    We can't use a simple delta for token1 because the user's USDC was already in
  //    the wallet before we snapshotted prevBalance1.  Instead:
  //      finalBalance0 = delta from prevBalance0  (wrap added WETH, swap may have added/removed it)
  //      finalBalance1 = intended1 + (postBalance1 - prevBalance1)
  //                    = intended1 - usdc_spent   (if swap sold USDC)
  //                    = intended1 + usdc_received (if swap bought USDC)
  //    This isolates exactly the intended capital regardless of pre-existing wallet funds.
  const [postBalance0, postBalance1] = await Promise.all([
    publicClient.readContract({ address: TOKEN0, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: TOKEN1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])
  const finalBalance0 = postBalance0 > prevBalance0 ? postBalance0 - prevBalance0 : 0n
  const usdcDelta = postBalance1 >= prevBalance1
    ? postBalance1 - prevBalance1          // swap added USDC (or no swap)
    : -(prevBalance1 - postBalance1)       // swap spent USDC (negative)
  const raw1 = intended1 + usdcDelta
  // Cap at actual wallet balance: if usdcAmount was rounded up slightly above the real
  // balance, raw1 can exceed postBalance1 by a few units, causing SafeTransferFrom to fail.
  const finalBalance1 = raw1 <= 0n ? 0n : raw1 > postBalance1 ? postBalance1 : raw1

  // 7. Approve position manager for both tokens — sequential to avoid nonce collision
  const approveTx0 = await walletClient.writeContract({ address: TOKEN0, abi: ERC20_ABI, functionName: 'approve', args: [POSITION_MANAGER, finalBalance0] })
  await trackTx(approveTx0, 'APPROVE')
  const approveTx1 = await walletClient.writeContract({ address: TOKEN1, abi: ERC20_ABI, functionName: 'approve', args: [POSITION_MANAGER, finalBalance1] })
  await trackTx(approveTx1, 'APPROVE')

  // 8. Mint new LP position
  const mintTx = await walletClient.writeContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'mint',
    args: [{
      token0: TOKEN0,
      token1: TOKEN1,
      fee: req.feeTier,
      tickLower: req.tickLower,
      tickUpper: req.tickUpper,
      amount0Desired: finalBalance0,
      amount1Desired: finalBalance1,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: account.address,
      deadline,
    }],
  })
  const mintReceipt = await trackTx(mintTx, 'MINT')

  // 9. Parse new tokenId from ERC721 Transfer event
  const transferLog = mintReceipt.logs.find(
    log => log.address.toLowerCase() === POSITION_MANAGER.toLowerCase()
      && log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  )
  const tokenId = transferLog?.topics[3] ? BigInt(transferLog.topics[3]).toString() : undefined

  // 10. Parse actual deposited amounts from IncreaseLiquidity event
  // keccak256("IncreaseLiquidity(uint256,uint128,uint256,uint256)")
  const INCREASE_LIQUIDITY_TOPIC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f'
  const mintLog = mintReceipt.logs.find(
    log => log.address.toLowerCase() === POSITION_MANAGER.toLowerCase()
      && log.topics[0]?.toLowerCase() === INCREASE_LIQUIDITY_TOPIC.toLowerCase()
  )
  let amount0: string | undefined
  let amount1: string | undefined
  if (mintLog?.data && mintLog.data !== '0x') {
    const data = mintLog.data.slice(2)
    // IncreaseLiquidity data: [liquidity(32 bytes)][amount0(32 bytes)][amount1(32 bytes)]
    // tokenId is indexed (topics[1]), so data starts with liquidity
    amount0 = BigInt('0x' + data.slice(64, 128)).toString()
    amount1 = BigInt('0x' + data.slice(128, 192)).toString()
  }

  // 11. Compute leftover — tokens that did not fit into the LP position
  const deposited0 = amount0 ? BigInt(amount0) : 0n
  const deposited1 = amount1 ? BigInt(amount1) : 0n
  const leftoverToken0 = (finalBalance0 > deposited0 ? finalBalance0 - deposited0 : 0n).toString()
  const leftoverToken1 = (finalBalance1 > deposited1 ? finalBalance1 - deposited1 : 0n).toString()

  // 12. Sum gas cost across all transactions
  const gasUsedWei = txDetails.reduce((acc, d) => acc + BigInt(d.gasUsedWei), 0n).toString()
  const txHashes = txDetails.map(d => d.txHash)

  return { success: true, tokenId, txHashes, txDetails, gasUsedWei, amount0, amount1, leftoverToken0, leftoverToken1 }
}
