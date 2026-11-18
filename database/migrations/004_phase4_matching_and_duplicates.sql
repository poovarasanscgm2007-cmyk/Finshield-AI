-- FINSHIELD AI - Phase 4 Migration: 3-Way Matching Details & Duplicate Threshold Calibration

ALTER TABLE match_results
  ADD COLUMN IF NOT EXISTS compared_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS qty_tolerance_percent NUMERIC(5, 2) NOT NULL DEFAULT 2.00,
  ADD COLUMN IF NOT EXISTS price_tolerance_percent NUMERIC(5, 2) NOT NULL DEFAULT 2.00,
  ADD COLUMN IF NOT EXISTS matched_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Calibrate default duplicate similarity threshold to 0.65 so normalized number + same supplier
-- triggers POSSIBLE DUPLICATE for human review while same number across unrelated suppliers stays below threshold.
UPDATE risk_rules_config
SET threshold = 0.6500,
    updated_at = NOW()
WHERE rule_code = 'DUPLICATE_INVOICE'
  AND threshold = 0.8000;
