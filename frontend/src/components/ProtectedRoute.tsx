import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { ROLE_LABELS, UserRole } from '../auth/permissions.ts';
import { useAuth } from '../context/AuthContext.tsx';

interface ProtectedRouteProps {
  children: ReactNode;
  allowedRoles?: UserRole[];
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-600">
        Verifying session...
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return (
      <div className="mx-auto max-w-xl rounded-lg border border-rose-200 bg-white p-6">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden="true" />
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              403 Forbidden — Access Restricted
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Your current role (<span className="font-medium text-slate-900">{ROLE_LABELS[user.role]}</span>)
              is not permitted to access this view.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
