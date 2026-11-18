-- FINSHIELD AI - Phase 1 Initial PostgreSQL Schema
-- Covers all 16 core tables for AP Risk, 3-Way Matching, GST Compliance,
-- PO Change Monitoring, Investigations, and Hash-Chained Audit Logging.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  employee_code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT,
  role VARCHAR(50) NOT NULL CHECK (
    role IN (
      'AP_EMPLOYEE',
      'PROCUREMENT_EMPLOYEE',
      'WAREHOUSE_EMPLOYEE',
      'FINANCE_MANAGER',
      'ADMIN'
    )
  ),
  department VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  supplier_code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  gstin VARCHAR(15) NOT NULL,
  pan VARCHAR(10) NOT NULL,
  state_code VARCHAR(2) NOT NULL,
  bank_identifier VARCHAR(120) NOT NULL,
  address TEXT NOT NULL,
  phone VARCHAR(30) NOT NULL,
  gst_filing_status VARCHAR(50) NOT NULL DEFAULT 'REGULAR',
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppliers_bank_identifier ON suppliers (bank_identifier);
CREATE INDEX IF NOT EXISTS idx_suppliers_gstin ON suppliers (gstin);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  po_number VARCHAR(50) NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  buyer_company VARCHAR(255) NOT NULL DEFAULT 'ABC Manufacturing',
  buyer_gstin VARCHAR(15) NOT NULL,
  buyer_state_code VARCHAR(2) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'ISSUED',
  original_total NUMERIC(14, 2) NOT NULL,
  current_total NUMERIC(14, 2) NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders (supplier_id);

CREATE TABLE IF NOT EXISTS po_lines (
  id SERIAL PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL DEFAULT 1,
  item_code VARCHAR(100),
  description TEXT NOT NULL,
  hsn_sac VARCHAR(20),
  original_quantity NUMERIC(14, 3) NOT NULL,
  current_quantity NUMERIC(14, 3) NOT NULL,
  unit VARCHAR(30) NOT NULL DEFAULT 'kg',
  original_unit_price NUMERIC(14, 2) NOT NULL,
  current_unit_price NUMERIC(14, 2) NOT NULL,
  gst_rate NUMERIC(5, 2) NOT NULL DEFAULT 18.00,
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_po_lines_po_id ON po_lines (po_id);

CREATE TABLE IF NOT EXISTS approvals (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  approval_level INTEGER NOT NULL DEFAULT 1,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'APPROVED', 'REJECTED')
  ),
  remarks TEXT,
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approvals_entity ON approvals (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS po_change_history (
  id SERIAL PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  po_line_id INTEGER REFERENCES po_lines(id) ON DELETE SET NULL,
  changed_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  field VARCHAR(100) NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  approval_id INTEGER REFERENCES approvals(id) ON DELETE SET NULL,
  reason TEXT,
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_po_change_history_po_id ON po_change_history (po_id);

CREATE TABLE IF NOT EXISTS grns (
  id SERIAL PRIMARY KEY,
  grn_number VARCHAR(50) NOT NULL UNIQUE,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  warehouse_location VARCHAR(120),
  status VARCHAR(30) NOT NULL DEFAULT 'RECEIVED',
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grns_po_id ON grns (po_id);

CREATE TABLE IF NOT EXISTS grn_lines (
  id SERIAL PRIMARY KEY,
  grn_id INTEGER NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
  po_line_id INTEGER REFERENCES po_lines(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity_received NUMERIC(14, 3) NOT NULL,
  unit VARCHAR(30) NOT NULL DEFAULT 'kg',
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grn_lines_grn_id ON grn_lines (grn_id);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  invoice_number VARCHAR(100) NOT NULL,
  normalized_invoice_number VARCHAR(100) NOT NULL,
  irn VARCHAR(100),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  po_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
  invoice_date DATE NOT NULL,
  subtotal NUMERIC(14, 2) NOT NULL,
  cgst NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  sgst NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  igst NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  extra_charges NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  total NUMERIC(14, 2) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING_REVIEW',
  extraction_confidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  file_path TEXT,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_historical BOOLEAN NOT NULL DEFAULT FALSE,
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON invoices (supplier_id);
CREATE INDEX IF NOT EXISTS idx_invoices_po ON invoices (po_id);
CREATE INDEX IF NOT EXISTS idx_invoices_normalized_num ON invoices (normalized_invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_irn ON invoices (irn);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL,
  hsn_sac VARCHAR(20),
  quantity NUMERIC(14, 3) NOT NULL,
  unit VARCHAR(30) NOT NULL DEFAULT 'kg',
  unit_price NUMERIC(14, 2) NOT NULL,
  extra_charge NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  tax_rate NUMERIC(5, 2) NOT NULL DEFAULT 18.00,
  line_total NUMERIC(14, 2) NOT NULL,
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice_id ON invoice_lines (invoice_id);

CREATE TABLE IF NOT EXISTS gstr2b_records (
  id SERIAL PRIMARY KEY,
  return_period VARCHAR(10) NOT NULL,
  supplier_gstin VARCHAR(15) NOT NULL,
  supplier_name VARCHAR(255) NOT NULL,
  invoice_number VARCHAR(100) NOT NULL,
  normalized_invoice_number VARCHAR(100) NOT NULL,
  invoice_date DATE NOT NULL,
  taxable_value NUMERIC(14, 2) NOT NULL,
  cgst NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  sgst NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  igst NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  itc_available BOOLEAN NOT NULL DEFAULT TRUE,
  irn VARCHAR(100),
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gstr2b_lookup ON gstr2b_records (supplier_gstin, normalized_invoice_number);

CREATE TABLE IF NOT EXISTS match_results (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL CHECK (status IN ('MATCHED', 'MISMATCH', 'HOLD')),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  tolerance_percent NUMERIC(5, 2) NOT NULL DEFAULT 2.00,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_match_results_invoice_id ON match_results (invoice_id);

CREATE TABLE IF NOT EXISTS risk_flags (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  rule_code VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  reason TEXT NOT NULL,
  score NUMERIC(6, 2) NOT NULL DEFAULT 0.00,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_flags_entity ON risk_flags (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS investigations (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  issue_type VARCHAR(100) NOT NULL,
  department VARCHAR(100) NOT NULL,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'OPEN' CHECK (
    status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'REVALIDATED', 'CLOSED')
  ),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolution_notes TEXT,
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investigations_invoice ON investigations (invoice_id);
CREATE INDEX IF NOT EXISTS idx_investigations_department ON investigations (department);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity VARCHAR(100) NOT NULL,
  entity_id VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash VARCHAR(64) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity, entity_id);

CREATE TABLE IF NOT EXISTS risk_rules_config (
  id SERIAL PRIMARY KEY,
  rule_code VARCHAR(100) NOT NULL UNIQUE,
  rule_name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  weight NUMERIC(6, 2) NOT NULL,
  threshold NUMERIC(14, 4) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
