import { createWalletClient, createPublicClient, http } from 'viem'
import { arbitrum } from 'viem/chains'
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export const config = {
  rpcUrl: requireEnv('ARBITRUM_RPC_URL'),
  /** Default wallet private key — optional when per-request walletPrivateKey is always provided */
  defaultPrivateKey: process.env['WALLET_PRIVATE_KEY'] as `0x${string}` | undefined,
}

export const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(config.rpcUrl),
})

/**
 * Create a wallet client for a given private key or BIP39 mnemonic phrase.
 * If no key is provided, falls back to the WALLET_PRIVATE_KEY env var.
 */
export function createWalletClientForKey(walletPhrase?: string) {
  const phrase = walletPhrase ?? config.defaultPrivateKey
  if (!phrase) {
    throw new Error('No wallet key: provide walletPrivateKey in the request or set WALLET_PRIVATE_KEY env var')
  }

  const account =
    phrase.startsWith('0x') && phrase.length === 66
      ? privateKeyToAccount(phrase as `0x${string}`)
      : mnemonicToAccount(phrase) // BIP39 mnemonic — derives m/44'/60'/0'/0/0

  return createWalletClient({
    chain: arbitrum,
    transport: http(config.rpcUrl),
    account,
  })
}

/** Default wallet client (used for read operations or when no per-request key is given) */
export const walletClient = config.defaultPrivateKey
  ? createWalletClientForKey(config.defaultPrivateKey)
  : null
