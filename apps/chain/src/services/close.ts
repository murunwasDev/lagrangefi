import { walletClient, publicClient } from '../config.js'
import type { CloseRequest, CloseResult } from '@lagrangefi/shared'

// Uniswap v3 NonfungiblePositionManager on Arbitrum
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' as const
const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' as const

const WETH_ABI = [
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
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
] as const

const MAX_UINT128 = 2n ** 128n - 1n
const DEADLINE_BUFFER = 300n // 5 minutes

export async function closePosition(req: CloseRequest): Promise<CloseResult> {
  const tokenId = BigInt(req.tokenId)
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_BUFFER
  const account = walletClient.account!
  const txHashes: string[] = []

  // 1. Fetch current position
  const position = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'positions',
    args: [tokenId],
  })
  const liquidity = position[7]

  // 2. Remove all liquidity (if any)
  if (liquidity > 0n) {
    const decreaseTx = await walletClient.writeContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'decreaseLiquidity',
      args: [{
        tokenId,
        liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline,
      }],
    })
    await publicClient.waitForTransactionReceipt({ hash: decreaseTx })
    txHashes.push(decreaseTx)
  }

  // 3. Collect all tokens and fees
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
  await publicClient.waitForTransactionReceipt({ hash: collectTx })
  txHashes.push(collectTx)

  // 4. Burn the NFT
  const burnTx = await walletClient.writeContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'burn',
    args: [tokenId],
  })
  await publicClient.waitForTransactionReceipt({ hash: burnTx })
  txHashes.push(burnTx)

  // 5. Unwrap WETH → ETH so the wallet holds native ETH for future LP starts
  const wethBalance = await publicClient.readContract({
    address: WETH,
    abi: WETH_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })
  if (wethBalance > 0n) {
    const unwrapTx = await walletClient.writeContract({
      address: WETH,
      abi: WETH_ABI,
      functionName: 'withdraw',
      args: [wethBalance],
    })
    await publicClient.waitForTransactionReceipt({ hash: unwrapTx })
    txHashes.push(unwrapTx)
  }

  return { success: true, txHashes }
}
