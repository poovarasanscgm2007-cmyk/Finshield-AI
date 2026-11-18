export const ROLES = [
  'AP_EMPLOYEE',
  'PROCUREMENT_EMPLOYEE',
  'WAREHOUSE_EMPLOYEE',
  'FINANCE_MANAGER',
  'ADMIN',
] as const;

export type UserRole = (typeof ROLES)[number];

export type Permission =
  | 'invoices:upload'
  | 'invoices:read'
  | 'matching:read'
  | 'investigations:create'
  | 'purchase_orders:read'
  | 'purchase_orders:edit_price'
  | 'issues:resolve_price'
  | 'grns:read'
  | 'grns:edit'
  | 'issues:resolve_quantity'
  | 'approvals:create'
  | 'approvals:read_own'
  | 'approvals:read_all'
  | 'approvals:decide_po_change'
  | 'approvals:decide_high_risk'
  | 'payments:approve_final'
  | 'risk:read_all'
  | 'risk_rules:manage'
  | 'users:manage'
  | 'audit_log:read'
  | 'audit_log:verify';

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  AP_EMPLOYEE: [
    'invoices:upload',
    'invoices:read',
    'matching:read',
    'investigations:create',
    'purchase_orders:read',
    'approvals:create',
    'approvals:read_own',
  ],
  PROCUREMENT_EMPLOYEE: [
    'purchase_orders:read',
    'purchase_orders:edit_price',
    'issues:resolve_price',
    'approvals:create',
    'approvals:read_own',
  ],
  WAREHOUSE_EMPLOYEE: [
    'grns:read',
    'grns:edit',
    'issues:resolve_quantity',
    'approvals:create',
    'approvals:read_own',
  ],
  FINANCE_MANAGER: [
    'invoices:read',
    'matching:read',
    'purchase_orders:read',
    'grns:read',
    'approvals:create',
    'approvals:read_all',
    'approvals:decide_po_change',
    'approvals:decide_high_risk',
    'payments:approve_final',
    'risk:read_all',
    'audit_log:read',
    'audit_log:verify',
  ],
  ADMIN: [
    'users:manage',
    'risk_rules:manage',
    'audit_log:read',
    'audit_log:verify',
    'approvals:read_all',
    'purchase_orders:read',
    'invoices:read',
    'grns:read',
    'risk:read_all',
    // Note: Admin intentionally does NOT have 'payments:approve_final' or 'approvals:decide_po_change'
  ],
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function isValidRole(role: string): role is UserRole {
  return (ROLES as readonly string[]).includes(role);
}
