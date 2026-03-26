import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login')
  }

  const navLink = (to: string, label: string) => (
    <Link
      to={to}
      className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${
        location.pathname.startsWith(to)
          ? 'bg-slate-700 text-white'
          : 'text-slate-400 hover:text-white'
      }`}
    >
      {label}
    </Link>
  )

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <nav className="border-b border-slate-700/50 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/dashboard" className="text-lg font-bold tracking-tight">lagrangefi</Link>
            {user && (
              <div className="flex items-center gap-1">
                {navLink('/dashboard', 'Dashboard')}
                {navLink('/strategies', 'Strategies')}
                {navLink('/wallet', 'Wallet')}
              </div>
            )}
          </div>
          {user && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400">{user.username}</span>
              <button
                onClick={handleLogout}
                className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded border border-slate-700 hover:border-slate-500 transition-colors"
              >
                Logout
              </button>
            </div>
          )}
        </div>
      </nav>
      <main className="max-w-5xl mx-auto px-4 py-8">{children}</main>
    </div>
  )
}
