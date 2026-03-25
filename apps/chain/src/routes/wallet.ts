import type { FastifyPluginAsync } from 'fastify'
import { walletClient, publicClient } from '../config.js'
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

export const walletRoutes: FastifyPluginAsync = async (server) => {
  // GET /wallet/balances — returns ETH and USDC balances of the bot wallet
  server.get('/balances', async () => {
    const address = walletClient.account!.address

    const [ethRaw, usdcRaw] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
    ])

    return {
      address,
      eth: formatEther(ethRaw),
      usdc: formatUnits(usdcRaw, 6),
    }
  })
}
