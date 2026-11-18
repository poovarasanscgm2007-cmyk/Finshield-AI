-- FINSHIELD AI - Phase 5 Migration: Investigations Workflow, Evidence, Comments, Pipeline Risk & Payment Gate

-- 1. Expand investigations status check to include REOPENED and add workflow/evidence fields
ALTER TABLE investigations
  DROP CONSTRAINT IF EXISTS investigations_status_check;

ALTER TABLE investigations
  ADD CONSTRAINT investigations_status_check
  CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'REVALIDATED', 'REOPENED', 'CLOSED'));

ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS severity VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
  ADD COLUMN IF NOT EXISTS title VARCHAR(255),
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS allowed_departments JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS revalidation_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_revalidated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_investigations_invoice_issue
  ON investigations (invoice_id, issue_type)
  WHERE invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_investigations_status ON investigations (status);
CREATE INDEX IF NOT EXISTS idx_investigations_assigned ON investigations (assigned_to);

-- 2. Investigation comments table (tracks every status transition and department note)
CREATE TABLE IF NOT EXISTS investigation_comments (
  id SERIAL PRIMARY KEY,
  investigation_id INTEGER NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT NOT NULL,
  status_from VARCHAR(40),
  status_to VARCHAR(40),
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investigation_comments_inv ON investigation_comments (investigation_id);

-- 3. Investigation evidence attachments (files, notes, record links)
CREATE TABLE IF NOT EXISTS investigation_evidence (
  id SERIAL PRIMARY KEY,
  investigation_id INTEGER NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  evidence_type VARCHAR(30) NOT NULL CHECK (evidence_type IN ('NOTE', 'FILE', 'RECORD_LINK')),
  note TEXT,
  file_path TEXT,
  original_filename VARCHAR(255),
  mime_type VARCHAR(100),
  file_size_bytes INTEGER,
  linked_entity_type VARCHAR(50),
  linked_entity_id VARCHAR(100),
  is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investigation_evidence_inv ON investigation_evidence (investigation_id);

-- 4. Persisted risk priority, ITC at risk, and human multi-level payment approval columns on invoices
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS risk_score NUMERIC(6, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20) NOT NULL DEFAULT 'LOW',
  ADD COLUMN IF NOT EXISTS itc_at_risk NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS level1_approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS level1_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_approved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_invoices_risk_level ON invoices (risk_level);
