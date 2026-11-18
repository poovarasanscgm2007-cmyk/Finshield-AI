import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DashboardLayout } from './components/DashboardLayout.tsx';
import { ProtectedRoute } from './components/ProtectedRoute.tsx';
import { AuthProvider } from './context/AuthContext.tsx';
import { ApprovalsPage } from './pages/ApprovalsPage.tsx';
import { AuditLogPage } from './pages/AuditLogPage.tsx';
import { InvoicesPage } from './pages/InvoicesPage.tsx';
import { InvoiceVerifyPage } from './pages/InvoiceVerifyPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { PlaceholderModulePage } from './pages/PlaceholderModulePage.tsx';

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
                    description="Full PO management and 3-way matching integration. Use Approvals & Guard to submit PO price change requests in Phase 2."
                    scheduledPhase="Phase 3"
                  />
                </ProtectedRoute>
              }
            />
            <Route
              path="/grns"
              element={
                <ProtectedRoute allowedRoles={['WAREHOUSE_EMPLOYEE', 'FINANCE_MANAGER', 'ADMIN']}>
                  <PlaceholderModulePage
                    title="Goods Receipt Notes (GRN)"
                    description="Warehouse GRN entry and multi-GRN quantity aggregation."
                    scheduledPhase="Phase 3"
                  />
                </ProtectedRoute>
              }
            />
            <Route
              path="/risk"
              element={
                <ProtectedRoute allowedRoles={['FINANCE_MANAGER', 'ADMIN']}>
                  <PlaceholderModulePage
                    title="Risk Alerts & GST Compliance"
                    description="3-way matching, GSTIN checksum & GSTR-2B checks, supplier graph, and AI Copilot."
                    scheduledPhase="Phase 4+"
                  />
                </ProtectedRoute>
              }
            />
            <Route
              path="/rules"
              element={
                <ProtectedRoute allowedRoles={['ADMIN']}>
                  <PlaceholderModulePage
                    title="Risk Rules Configuration"
                    description="Configure rule weights and matching tolerance thresholds."
                    scheduledPhase="Phase 4+"
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
                    scheduledPhase="Phase 4+"
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
