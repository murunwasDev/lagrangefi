import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

function ActivityIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}

function LogOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
    </svg>
  )
}


export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const isActive = (path: string) => location.pathname.startsWith(path)

  function handleLogout() {
    logout()
    navigate('/login')
  }

  const navItem = (to: string, icon: React.ReactNode, label: string) => {
    const active = isActive(to)
    return (
      <Link
        to={to}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 ${
          active
            ? 'bg-gray-900/90 text-white shadow-sm'
            : 'text-gray-500 hover:text-gray-900 hover:bg-white/50'
        }`}
      >
        {icon}
        {label}
      </Link>
    )
  }

  return (
    <div className="flex min-h-screen relative">

      {/* Ambient background blobs */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute -top-32 -right-32 w-[500px] h-[500px] bg-emerald-400/25 rounded-full blur-[100px]" />
        <div className="absolute -bottom-32 -left-32 w-[500px] h-[500px] bg-blue-500/20 rounded-full blur-[100px]" />
        <div className="absolute top-1/2 left-1/3 -translate-y-1/2 w-[600px] h-[400px] bg-violet-400/15 rounded-full blur-[120px]" />
      </div>

      {/* Sidebar */}
      <aside className="w-56 backdrop-blur-2xl bg-white/40 border-r border-white/60 flex flex-col shrink-0 shadow-xl shadow-black/5">

        {/* Logo */}
        <Link to="/strategies" className="flex items-center gap-2.5 px-4 py-5 border-b border-white/50 group">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-gradient-to-br from-gray-800 to-gray-950 shadow-md group-hover:shadow-lg transition-shadow">
            <span className="text-white font-bold text-sm leading-none">Δ</span>
          </div>
          <span className="text-gray-900 font-bold text-sm tracking-tight">lagrangefi</span>
        </Link>

        {/* Nav */}
        {user && (
          <nav className="flex-1 px-2 py-4 space-y-0.5">
            {navItem('/strategies', <ActivityIcon />, 'Strategies')}
          </nav>
        )}

        {/* Profile card */}
        {user && (
          <div className="mx-2 mb-3">
            <div className="bg-white/50 backdrop-blur-sm border border-white/70 rounded-2xl overflow-hidden shadow-sm">

              {/* User info row */}
              <Link to="/profile" className="flex items-center gap-3 px-3 pt-3 pb-2.5 hover:bg-white/40 transition-colors">
                {/* Avatar */}
                <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-gradient-to-br from-gray-700 to-gray-950 shadow-md">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="8" r="4"/>
                    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-900 truncate leading-tight">{user.username}</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <p className="text-xs text-gray-400 leading-tight">
                      {user.hasWallet ? 'Wallet connected' : 'No wallet'}
                    </p>
                  </div>
                </div>
              </Link>

              {/* Action row */}
              <div className="flex border-t border-white/60">
                <Link
                  to="/profile"
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-gray-400 hover:text-gray-700 hover:bg-white/40 transition-all"
                >
                  <SettingsIcon />
                  Settings
                </Link>
                <div className="w-px bg-white/60" />
                <button
                  onClick={handleLogout}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-gray-400 hover:text-red-500 hover:bg-red-50/50 transition-all"
                >
                  <LogOutIcon />
                  Log out
                </button>
              </div>

            </div>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  )
}
