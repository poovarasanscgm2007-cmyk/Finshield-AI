-- FINSHIELD AI - Phase 2 Migration: Maker-Checker Approvals, PO Change Status, and Append-Only Audit Log

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status);

ALTER TABLE po_change_history
  ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'UNAPPROVED';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_po_change_history_status'
  ) THEN
    ALTER TABLE po_change_history
      ADD CONSTRAINT chk_po_change_history_status
      CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'UNAPPROVED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_po_change_history_status ON po_change_history (status);

-- Ensure any existing unapproved PO change history rows without an approval_id remain UNAPPROVED
UPDATE po_change_history
SET status = 'UNAPPROVED'
WHERE approval_id IS NULL;

-- Enforce append-only semantics on audit_log (block UPDATE and DELETE)
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % operations are prohibited', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit_log;
CREATE TRIGGER trg_audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_mutation();

DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit_log;
CREATE TRIGGER trg_audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_mutation();
