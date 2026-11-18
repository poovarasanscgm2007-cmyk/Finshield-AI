export type UserRole =
  | 'AP_EMPLOYEE'
  | 'PROCUREMENT_EMPLOYEE'
  | 'WAREHOUSE_EMPLOYEE'
  | 'FINANCE_MANAGER'
  | 'ADMIN';

export const ROLE_LABELS: Record<UserRole, string> = {
  AP_EMPLOYEE: 'AP Employee',
  PROCUREMENT_EMPLOYEE: 'Procurement Employee',
  WAREHOUSE_EMPLOYEE: 'Warehouse Employee',
  FINANCE_MANAGER: 'Finance Manager',
  ADMIN: 'Admin',
};

export const ROLE_CAPABILITIES: Record<UserRole, string[]> = {
  AP_EMPLOYEE: [
    'Upload invoices & view invoices',
    'View 3-way matching results',
    'Create investigation issues',
    'View own approval requests',
  ],
  PROCUREMENT_EMPLOYEE: [
    'View purchase orders',
    'Request PO price changes (maker-checker approval required)',
    'Resolve price issues',
    'View own approval requests',
  ],
  WAREHOUSE_EMPLOYEE: [
    'View and edit GRNs',
    'Resolve quantity mismatch issues',
    'View own approval requests',
  ],
  FINANCE_MANAGER: [
    'Approve or reject PO price changes',
    'Approve high-risk items & final payments',
    'View all risk data, POs, invoices, and GRNs',
    'View & verify hash-chained audit log',
  ],
  ADMIN: [
    'Manage users and risk rule configuration',
    'View & verify hash-chained audit log',
    'View system records (cannot approve payments or PO changes)',
  ],
};

export interface NavItemConfig {
  path: string;
  label: string;
  allowedRoles: UserRole[];
  isPlaceholder?: boolean;
}

export const SIDEBAR_NAV_ITEMS: NavItemConfig[] = [
  {
    path: '/',
    label: 'Overview',
    allowedRoles: [
      'AP_EMPLOYEE',
      'PROCUREMENT_EMPLOYEE',
      'WAREHOUSE_EMPLOYEE',
      'FINANCE_MANAGER',
      'ADMIN',
    ],
  },
  {
    path: '/approvals',
    label: 'Approvals & Guard',
    allowedRoles: [
      'AP_EMPLOYEE',
      'PROCUREMENT_EMPLOYEE',
      'WAREHOUSE_EMPLOYEE',
      'FINANCE_MANAGER',
      'ADMIN',
    ],
  },
  {
    path: '/audit-log',
    label: 'Audit Log',
    allowedRoles: ['FINANCE_MANAGER', 'ADMIN'],
  },
  {
    path: '/invoices',
    label: 'Invoices',
    allowedRoles: ['AP_EMPLOYEE', 'FINANCE_MANAGER', 'ADMIN'],
    isPlaceholder: true,
  },
  {
    path: '/purchase-orders',
    label: 'Purchase Orders',
    allowedRoles: ['PROCUREMENT_EMPLOYEE', 'FINANCE_MANAGER', 'ADMIN', 'AP_EMPLOYEE'],
    isPlaceholder: true,
  },
  {
    path: '/grns',
    label: 'GRNs',
    allowedRoles: ['WAREHOUSE_EMPLOYEE', 'FINANCE_MANAGER', 'ADMIN'],
    isPlaceholder: true,
  },
  {
    path: '/risk',
    label: 'Risk & Compliance',
    allowedRoles: ['FINANCE_MANAGER', 'ADMIN'],
    isPlaceholder: true,
  },
  {
    path: '/rules',
    label: 'Risk Rules Config',
    allowedRoles: ['ADMIN'],
    isPlaceholder: true,
  },
  {
    path: '/users',
    label: 'User Management',
    allowedRoles: ['ADMIN'],
    isPlaceholder: true,
  },
];
