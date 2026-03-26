import { parseEther, parseUnits } from 'viem'
import { createWalletClientForKey, publicClient } from '../config.js'
import { calculateSwapAmount, executeSwap, getTokenDecimals } from './swap.js'
import { getPoolStateByPair } from './uniswap.js'
import type { MintRequest, MintResult } from '@lagrangefi/shared'

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
  const txHashes: string[] = []
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_BUFFER

  // 1. Wrap ETH → WETH if requested
  const ethAmt = parseFloat(req.ethAmount)
  if (!isNaN(ethAmt) && ethAmt > 0) {
    const wrapTx = await walletClient.writeContract({
      address: WETH,
      abi: WETH_ABI,
      functionName: 'deposit',
      value: parseEther(req.ethAmount),
    })
    await publicClient.waitForTransactionReceipt({ hash: wrapTx })
    txHashes.push(wrapTx)
  }

  // 2. Transfer USDC into wallet (already there — user must have sent it to the wallet)
  // We use the full wallet balance of both tokens for the position

  // 3. Get pool state for swap calculation
  const poolState = await getPoolStateByPair(TOKEN0, TOKEN1, req.feeTier)
  const sqrtPriceX96 = BigInt(poolState.sqrtPriceX96)

  // 4. Fetch decimals + current balances
  const [decimals0, decimals1] = await Promise.all([
    getTokenDecimals(TOKEN0),
    getTokenDecimals(TOKEN1),
  ])

  const [balance0, balance1] = await Promise.all([
    publicClient.readContract({ address: TOKEN0, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: TOKEN1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])

  // 5. Calculate and execute optimal swap if needed
  const swap = calculateSwapAmount({
    balance0,
    balance1,
    decimals0,
    decimals1,
    sqrtPriceX96,
    newTickLower: req.tickLower,
    newTickUpper: req.tickUpper,
    slippageTolerance: req.slippageTolerance,
  })

  if (swap !== null) {
    const [tokenIn, tokenOut] = swap.zeroForOne ? [TOKEN0, TOKEN1] : [TOKEN1, TOKEN0]
    const swapTx = await executeSwap({
      tokenIn,
      tokenOut,
      fee: req.feeTier,
      amountIn: swap.amountIn,
      amountOutMinimum: swap.amountOutMinimum,
      deadline,
      walletClient,
    })
    txHashes.push(swapTx)
  }

  // 6. Re-fetch balances after swap
  const [finalBalance0, finalBalance1] = await Promise.all([
    publicClient.readContract({ address: TOKEN0, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: TOKEN1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])

  // 7. Approve position manager for both tokens — sequential to avoid nonce collision
  const approveTx0 = await walletClient.writeContract({ address: TOKEN0, abi: ERC20_ABI, functionName: 'approve', args: [POSITION_MANAGER, finalBalance0] })
  await publicClient.waitForTransactionReceipt({ hash: approveTx0 })
  const approveTx1 = await walletClient.writeContract({ address: TOKEN1, abi: ERC20_ABI, functionName: 'approve', args: [POSITION_MANAGER, finalBalance1] })
  await publicClient.waitForTransactionReceipt({ hash: approveTx1 })
  txHashes.push(approveTx0, approveTx1)

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
  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintTx })
  txHashes.push(mintTx)

  // 9. Parse new tokenId from ERC721 Transfer event
  const transferLog = mintReceipt.logs.find(
    log => log.address.toLowerCase() === POSITION_MANAGER.toLowerCase()
      && log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  )
  const tokenId = transferLog?.topics[3] ? BigInt(transferLog.topics[3]).toString() : undefined

  return { success: true, tokenId, txHashes }
}
