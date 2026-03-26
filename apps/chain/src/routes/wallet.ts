import type { FastifyPluginAsync } from 'fastify'
import { createWalletClientForKey, publicClient } from '../config.js'
import { formatEther, formatUnits } from 'viem'

const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831' as const

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

async function getBalances(walletPhrase?: string) {
  const address = createWalletClientForKey(walletPhrase).account!.address
  const [ethRaw, usdcRaw] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
  ])
  return { address, eth: formatEther(ethRaw), usdc: formatUnits(usdcRaw, 6) }
}

export const walletRoutes: FastifyPluginAsync = async (server) => {
  // GET /wallet/balances — returns balances of the default (env-var) wallet
  server.get('/balances', async () => getBalances())

  // POST /wallet/balances — returns balances for a specific wallet key (per-user)
  server.post<{ Body: { walletPrivateKey?: string } }>('/balances', async (request) => {
    return getBalances(request.body.walletPrivateKey)
  })
}
