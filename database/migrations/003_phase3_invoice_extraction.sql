-- FINSHIELD AI - Phase 3 Migration: Invoice Upload, OCR/AI Extraction & Human Verification

ALTER TABLE invoices
  ALTER COLUMN supplier_id DROP NOT NULL,
  ALTER COLUMN invoice_number DROP NOT NULL,
  ALTER COLUMN normalized_invoice_number DROP NOT NULL,
  ALTER COLUMN invoice_date DROP NOT NULL,
  ALTER COLUMN subtotal DROP NOT NULL,
  ALTER COLUMN total DROP NOT NULL;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS supplier_name_extracted TEXT,
  ADD COLUMN IF NOT EXISTS supplier_gstin_extracted VARCHAR(30),
  ADD COLUMN IF NOT EXISTS po_reference_extracted VARCHAR(100),
  ADD COLUMN IF NOT EXISTS bank_identifier_extracted VARCHAR(120),
  ADD COLUMN IF NOT EXISTS extraction_source VARCHAR(20),
  ADD COLUMN IF NOT EXISTS extraction_method VARCHAR(30),
  ADD COLUMN IF NOT EXISTS raw_extracted_text TEXT,
  ADD COLUMN IF NOT EXISTS original_extracted_data JSONB,
  ADD COLUMN IF NOT EXISTS verified_data JSONB,
  ADD COLUMN IF NOT EXISTS verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS original_filename VARCHAR(255),
  ADD COLUMN IF NOT EXISTS file_size_bytes INTEGER;

CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
