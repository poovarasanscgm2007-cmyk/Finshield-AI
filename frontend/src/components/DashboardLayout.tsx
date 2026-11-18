import { LogOut, ShieldCheck } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ROLE_LABELS, SIDEBAR_NAV_ITEMS } from '../auth/permissions.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { SampleDataBanner } from './SampleDataBanner.tsx';

export function DashboardLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();

  if (!user) {
    return null;
  }

  const allowedNavItems = SIDEBAR_NAV_ITEMS.filter((item) =>
    item.allowedRoles.includes(user.role)
  );

  const currentNav =
    allowedNavItems.find((item) => item.path === location.pathname) ||
    (location.pathname.startsWith('/invoices/')
      ? { path: '/invoices', label: 'Invoice Verification' }
      : undefined);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <SampleDataBanner />

      <div className="flex min-h-[calc(100vh-41px)]">
        <aside className="w-64 shrink-0 border-r border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              </div>
              <span className="text-sm font-bold tracking-tight text-slate-900 whitespace-nowrap">
                FINSHIELD AI
              </span>
            </div>
          </div>

          <nav aria-label="Role navigation" className="space-y-1 p-3">
            {allowedNavItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) =>
                  `flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                  }`
                }
              >
                <span className="truncate">{item.label}</span>
                {item.isPlaceholder && (
                  <span className="ml-2 text-xs opacity-60">Soon</span>
                )}
              </NavLink>
            ))}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-8 border-b border-slate-200 bg-white px-8 py-4">
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-slate-900">
                {currentNav ? currentNav.label : 'Workspace'}
              </h1>
            </div>

            <div className="flex items-center gap-6 shrink-0">
              <div className="text-right text-sm">
                <p className="font-medium text-slate-900 whitespace-nowrap">{user.name}</p>
                <p className="text-xs text-slate-500 whitespace-nowrap">
                  {ROLE_LABELS[user.role]} · {user.employeeCode}
                </p>
              </div>

              <button
                type="button"
                onClick={logout}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                Sign Out
              </button>
            </div>
          </header>

          <main className="mx-auto w-full max-w-6xl flex-1 px-8 py-8">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
