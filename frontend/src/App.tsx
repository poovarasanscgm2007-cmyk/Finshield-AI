import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DashboardLayout } from './components/DashboardLayout.tsx';
import { ProtectedRoute } from './components/ProtectedRoute.tsx';
import { AuthProvider } from './context/AuthContext.tsx';
import { ApprovalsPage } from './pages/ApprovalsPage.tsx';
import { AuditLogPage } from './pages/AuditLogPage.tsx';
import { DemoGuidePage } from './pages/DemoGuidePage.tsx';
import { GrnsPage } from './pages/GrnsPage.tsx';
import { InvestigationsPage } from './pages/InvestigationsPage.tsx';
import { InvoicesPage } from './pages/InvoicesPage.tsx';
import { InvoiceVerifyPage } from './pages/InvoiceVerifyPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { PlaceholderModulePage } from './pages/PlaceholderModulePage.tsx';
import { SupplierGraphPage } from './pages/SupplierGraphPage.tsx';
import { SuppliersPage } from './pages/SuppliersPage.tsx';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            element={
              <ProtectedRoute>
                <DashboardLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<OverviewPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route
              path="/audit-log"
              element={
                <ProtectedRoute allowedRoles={['ADMIN', 'FINANCE_MANAGER']}>
                  <AuditLogPage />
                </ProtectedRoute>
              }
            />
            <Route path="/invoices" element={<InvoicesPage />} />
            <Route path="/invoices/:id" element={<InvoiceVerifyPage />} />
            <Route path="/investigations" element={<InvestigationsPage />} />
            <Route path="/supplier-graph" element={<SupplierGraphPage />} />
            <Route path="/suppliers" element={<SuppliersPage />} />
            <Route
              path="/demo-guide"
              element={
                <ProtectedRoute allowedRoles={['ADMIN', 'FINANCE_MANAGER']}>
                  <DemoGuidePage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/purchase-orders"
              element={
                <ProtectedRoute
                  allowedRoles={[
                    'PROCUREMENT_EMPLOYEE',
                    'FINANCE_MANAGER',
                    'ADMIN',
                    'AP_EMPLOYEE',
                  ]}
                >
                  <PlaceholderModulePage
                    title="Purchase Orders Ledger"
                    description="Full PO management and 3-way matching integration. Use Approvals & Guard to submit PO price change requests."
                    scheduledPhase="Upcoming"
                  />
                </ProtectedRoute>
              }
            />
            <Route
              path="/grns"
              element={
                <ProtectedRoute allowedRoles={['WAREHOUSE_EMPLOYEE', 'FINANCE_MANAGER', 'ADMIN']}>
                  <GrnsPage />
                </ProtectedRoute>
              }
            />
            <Route path="/risk" element={<Navigate to="/supplier-graph" replace />} />
            <Route
              path="/rules"
              element={
                <ProtectedRoute allowedRoles={['ADMIN']}>
                  <PlaceholderModulePage
                    title="Risk Rules Configuration"
                    description="Configure rule weights and matching tolerance thresholds."
                    scheduledPhase="Phase 6"
                  />
                </ProtectedRoute>
              }
            />
            <Route
              path="/users"
              element={
                <ProtectedRoute allowedRoles={['ADMIN']}>
                  <PlaceholderModulePage
                    title="User & Role Management"
                    description="Manage organization users and RBAC role assignments."
                    scheduledPhase="Phase 6"
                  />
                </ProtectedRoute>
              }
            />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
