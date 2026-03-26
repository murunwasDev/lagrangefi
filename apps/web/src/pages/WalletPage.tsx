import { useState, useEffect, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchWalletStatus, saveWallet } from '../api'
import { useAuth } from '../context/AuthContext'

export default function WalletPage() {
  const { user, setUser } = useAuth()
  const navigate = useNavigate()
  const [phrase, setPhrase] = useState('')
  const [hasWallet, setHasWallet] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetchWalletStatus().then(r => setHasWallet(r.hasWallet))
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    setLoading(true)
    try {
      await saveWallet(phrase)
      setHasWallet(true)
      setSuccess(true)
      setPhrase('')
      if (user) setUser({ ...user, hasWallet: true })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save wallet')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Wallet</h1>
        <p className="text-slate-400 text-sm mt-1">
          Your wallet phrase is encrypted with AES-256-GCM before storage. It is never returned to the client.
        </p>
      </div>

      {hasWallet && !success && (
        <div className="mb-4 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm rounded-lg px-4 py-3">
          Wallet configured. You can replace it below.
        </div>
      )}

      {success && (
        <div className="mb-4 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm rounded-lg px-4 py-3">
          Wallet saved successfully.{' '}
          <button className="underline" onClick={() => navigate('/strategies')}>Create a strategy →</button>
        </div>
      )}

      {error && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 space-y-4">
        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Wallet phrase <span className="text-slate-500">(BIP39 mnemonic or raw private key 0x...)</span>
          </label>
          <textarea
            className="w-full bg-slate-700/50 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors resize-none font-mono"
            value={phrase}
            onChange={e => setPhrase(e.target.value)}
            placeholder="word1 word2 word3 ... word12"
            rows={3}
            required
          />
          <p className="text-xs text-slate-500 mt-1">
            Enter a 12 or 24-word mnemonic (derivation path m/44'/60'/0'/0/0) or a hex private key.
          </p>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors"
        >
          {loading ? 'Saving...' : hasWallet ? 'Replace wallet' : 'Save wallet'}
        </button>
      </form>
    </div>
  )
}
