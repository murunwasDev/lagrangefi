import { createWalletClientForKey, publicClient } from '../config.js'
import type { CloseRequest, CloseResult, TxDetail } from '@lagrangefi/shared'

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

// keccak256("Collect(uint256,address,uint256,uint256)")
const COLLECT_EVENT_TOPIC = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01' as const

function parseTotalCollected(
  receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>
): { amount0: bigint; amount1: bigint } | undefined {
  const log = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === POSITION_MANAGER.toLowerCase() &&
      l.topics[0]?.toLowerCase() === COLLECT_EVENT_TOPIC.toLowerCase()
  )
  if (!log || !log.data || log.data === '0x') return undefined
  const data = log.data.slice(2)
  if (data.length < 192) return undefined
  const amount0 = BigInt('0x' + data.slice(64, 128))
  const amount1 = BigInt('0x' + data.slice(128, 192))
  return { amount0, amount1 }
}


export async function closePosition(req: CloseRequest): Promise<CloseResult> {
  const walletClient = createWalletClientForKey(req.walletPrivateKey)
  const tokenId = BigInt(req.tokenId)
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_BUFFER
  const account = walletClient.account!
  const txDetails: TxDetail[] = []

  // Fetch gas price once with a 50% buffer — prevents partial close if baseFee rises mid-execution
  const feeData = await publicClient.estimateFeesPerGas()
  const maxFeePerGas = feeData.maxFeePerGas !== undefined
    ? (feeData.maxFeePerGas * 3n) / 2n
    : undefined
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas

  const trackTx = async (hash: `0x${string}`, action: string) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    txDetails.push({ txHash: hash, action, gasUsedWei: Number(receipt.gasUsed * receipt.effectiveGasPrice) })
    return receipt
  }

  // 1. Fetch current position
  const position = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'positions',
    args: [tokenId],
  })
  const liquidity = position[7]

  // 2. Simulate decreaseLiquidity to capture principal before executing
  // (fees = total_collected - principal)
  let principal0 = 0n
  let principal1 = 0n
  if (liquidity > 0n) {
    try {
      const sim = await publicClient.simulateContract({
        address: POSITION_MANAGER,
        abi: POSITION_MANAGER_ABI,
        functionName: 'decreaseLiquidity',
        account: account.address,
        args: [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline }],
      })
      principal0 = sim.result[0]
      principal1 = sim.result[1]
    } catch {
      // non-fatal: fees will be 0 (conservative fallback)
    }

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
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    const decreaseReceipt = await trackTx(decreaseTx, 'REMOVE_LIQUIDITY')
    if (decreaseReceipt.status === 'reverted') {
      throw new Error(`decreaseLiquidity reverted (tx: ${decreaseTx})`)
    }
  }

  // 3. Execute collect and parse exact amounts from the Collect event
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
  const collected = parseTotalCollected(collectReceipt)

  // 4. Burn the NFT
  const burnTx = await walletClient.writeContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'burn',
    args: [tokenId],
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  await trackTx(burnTx, 'BURN')

  // 5. Unwrap WETH from this position + any pending WETH from the last rebalance cycle
  const pending0 = BigInt(req.pendingToken0 ?? '0')
  const pending1 = BigInt(req.pendingToken1 ?? '0')
  const wethToUnwrap = (collected?.amount0 ?? 0n) + pending0
  if (wethToUnwrap > 0n) {
    const unwrapTx = await walletClient.writeContract({
      address: WETH,
      abi: WETH_ABI,
      functionName: 'withdraw',
      args: [wethToUnwrap],
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    await trackTx(unwrapTx, 'WITHDRAW_TO_WALLET')
  }

  const totalCollected0 = collected?.amount0 ?? 0n
  const totalCollected1 = collected?.amount1 ?? 0n

  // Include pending tokens in reported amounts so P&L reflects all capital returned
  const token0Amount = (totalCollected0 + pending0).toString()
  const token1Amount = (totalCollected1 + pending1).toString()

  const feesCollected = {
    amount0: (totalCollected0 > principal0 ? totalCollected0 - principal0 : 0n).toString(),
    amount1: (totalCollected1 > principal1 ? totalCollected1 - principal1 : 0n).toString(),
  }

  const txHashes = txDetails.map(d => d.txHash)
  const gasUsedWei = txDetails.reduce((acc, d) => acc + BigInt(d.gasUsedWei), 0n).toString()

  return { success: true, txHashes, txDetails, token0Amount, token1Amount, feesCollected, gasUsedWei }
}
