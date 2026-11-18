# FINSHIELD AI — Phase 1 Database Schema & Sample Scenario

> **Note:** All records seeded in Phase 1 are **Sample data** (`is_sample_data = TRUE`) representing the fictional company **ABC Manufacturing (Sample)**.

## Tables Overview

1. **`users`**: RBAC users across the 5 platform roles (`AP_EMPLOYEE`, `PROCUREMENT_EMPLOYEE`, `WAREHOUSE_EMPLOYEE`, `FINANCE_MANAGER`, `ADMIN`), including `Employee 102` (`EMP-102`).
2. **`suppliers`**: Vendor master with `gstin`, `pan`, `state_code`, `bank_identifier`, `address`, `phone`, `gst_filing_status`.
3. **`purchase_orders`** & **`po_lines`**: Stores both `original_*` and `current_*` quantities/prices so unauthorized PO tampering is always detectable.
4. **`approvals`**: Maker-checker approval records (`requested_by`, `approved_by`, `approval_level`, `status`, `payload`).
5. **`po_change_history`**: Immutable audit of PO edits (`po_id`, `changed_by`, `changed_at`, `field`, `old_value`, `new_value`, `approval_id`, `status`).
6. **`grns`** & **`grn_lines`**: Goods Receipt Notes linked to POs (multiple GRNs per PO supported).
7. **`invoices`** & **`invoice_lines`**: Uploaded/historical vendor invoices with `normalized_invoice_number`, `irn`, tax breakdown (`cgst`, `sgst`, `igst`), `extra_charges`, and per-field `extraction_confidence` JSONB.
8. **`gstr2b_records`**: Sample GSTR-2B return records for ITC reconciliation.
9. **`match_results`**: 3-way match output (`MATCHED`, `MISMATCH`, `HOLD`) with `reasons` JSONB.
10. **`risk_flags`**: Explainable risk alerts per rule code, severity, score, and reason text.
11. **`investigations`**: Auto-assigned department investigation workflow (`Warehouse`, `Procurement`, `Finance`, `Compliance`).
12. **`audit_log`**: Tamper-evident, append-only hash-chained log (`prev_hash`, `hash`) protected by PostgreSQL `BEFORE UPDATE` / `BEFORE DELETE` triggers.
13. **`risk_rules_config`**: Configurable rule weights and thresholds.
