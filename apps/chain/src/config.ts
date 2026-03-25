import { createWalletClient, createPublicClient, http } from 'viem'
import { arbitrum } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export const config = {
  rpcUrl: requireEnv('ARBITRUM_RPC_URL'),
  privateKey: requireEnv('WALLET_PRIVATE_KEY') as `0x${string}`,
}

export const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(config.rpcUrl),
})

export const walletClient = createWalletClient({
  chain: arbitrum,
  transport: http(config.rpcUrl),
  account: privateKeyToAccount(config.privateKey),
})
