# FINSHIELD AI — Live Demo Script (10-Step Flow)

> **Sample Data Notice:** All companies (`ABC Manufacturing`), suppliers (`SUP-A`, `SUP-B`), POs, GRNs, invoices, and GSTR-2B rows in this walkthrough are **Sample data** for prototype verification.
> **Human-in-the-Loop Rule:** AI never releases payment. Risk scores indicate **investigation priority**, never a fraud verdict.

---

## Pre-Demo Reset

Before starting a live presentation, reset the database to a clean demo state:

```bash
npm run reset-demo
```

Or sign in as **Admin** (`admin@abcmfg.sample` / `SamplePass@105`) or **Finance Manager** (`finance.manager@abcmfg.sample` / `SamplePass@104`), open **Demo Guide**, and click **Reset demo data**.

---

## 10-Step Demo Walkthrough

### Step 1 — Login by Role (RBAC & Sample Data Context)
- **Screen:** Login / Demo Guide (`/demo-guide`) / Overview (`/`)
- **Action:** Sign in as **AP Employee** (`ap.employee@abcmfg.sample` / `SamplePass@101`) using the Login form or Demo Guide Quick Login.
- **Expected Result:** Navigation shows only AP Employee capabilities. The global **Sample data** banner appears at the top of every screen. Attempting restricted routes (like `/audit-log` or `/api/audit-log`) returns `403`.

### Step 2 — Upload Sample Invoice & OCR/AI Extraction
- **Screen:** Invoices (`/invoices`)
- **Action:** Upload `INV-101-sample.pdf` (digital PDF) or `INV-099-scanned-sample.pdf` (scanned image PDF) from `/sample-data/invoices`.
- **Expected Result:**
  - `INV-101-sample.pdf` extracts fields (`INV-101`, GSTIN `27AABCS5678C1Z9`, PO `PO-101`, subtotal `50,000`, total `59,000`) with per-field confidence scores.
  - `INV-099-scanned-sample.pdf` runs through Tesseract OCR (`tesseract.js`) and enters `NEEDS_VERIFICATION` because low-confidence fields require human review.

### Step 3 — Human Verification & Normalized Duplicate Detection
- **Screen:** Invoice Verification (`/invoices/:id`)
- **Action:** Correct/confirm any low-confidence fields on a `NEEDS_VERIFICATION` invoice, or open the seeded **INV-101** invoice and check the **Duplicate Detection** panel.
- **Expected Result:** Normalized invoice numbers (`INV-101`, `INV 101`, `INV_101` → `INV101`) detect seeded `INV_101` as a `POSSIBLE DUPLICATE` with similarity score and reasons. Human review is required; invoices are never auto-rejected.

### Step 4 — 3-Way Matching (`PO-101` vs `GRN-101` vs `INV-101`)
- **Screen:** Invoice Verification (`/invoices/:id`)
- **Action:** Inspect the side-by-side PO, GRN, and Invoice comparison on `INV-101` (or click **Run Matching**).
- **Expected Result:**
  - Match status: `MISMATCH` and invoice status: `ON_HOLD`.
  - Exact reason: `"Invoice qty 100 exceeds received qty 80 by 20"`.
  - `PO-101` unapproved price modification (`Rs 500 -> Rs 700` by `Employee 102`) is highlighted.

### Step 5 — GST Validation & GSTR-2B ITC at Risk
- **Screen:** Invoice Verification (`/invoices/:id`) — GST & Risk Panel
- **Action:** Inspect GSTIN validation, intra-state CGST+SGST tax check, and GSTR-2B reconciliation for `INV-101`.
- **Expected Result:**
  - Supplier GSTIN `27AABCS5678C1Z9` passes 15-character format & Mod-36 checksum.
  - Intra-state Maharashtra (`27` → `27`) CGST (`4,500`) + SGST (`4,500`) validated.
  - `INV-101` is missing from sample GSTR-2B (`GSTR2B_MISSING`), flagging **Rs 9,000.00 ITC at risk**.

### Step 6 — Explainable Risk Alerts & Supplier Scorecard
- **Screen:** Overview (`/`) & Suppliers & Scorecards (`/suppliers`)
- **Action:** Switch to **Finance Manager** (`finance.manager@abcmfg.sample` / `SamplePass@104`). Review `INV-101` risk priority (`HIGH`) and open **Suppliers & Scorecards** for Supplier A (`SUP-A`).
- **Expected Result:**
  - Every risk point lists explicit reasons including Supplier A's historical repeated extra charges (`Rs 500`, `Rs 700`, `Rs 1,000`).
  - Supplier Scorecard shows 6 weighted metrics with exact formulas, PostgreSQL inputs, Recharts breakdown chart, and `"operational performance score — not a fraud verdict"` wording.

### Step 7 — Supplier Relationship Graph
- **Screen:** Supplier Graph (`/supplier-graph`)
- **Action:** Open **Supplier Graph** and click the red `SHARED_BANK` edge connecting Supplier A (`SUP-A`) and Supplier B (`SUP-B`).
- **Expected Result:**
  - Displays masked bank identifier (`XXXX8877`), `"Relationship requires verification"` banner/reason, and clickable link to the auto-created `FINANCE & COMPLIANCE` investigation (`SUPPLIER_RISK`).
  - Also allows submitting a **Bank Change Verification** request on `/suppliers` (requires Finance Manager maker-checker approval before taking effect).

### Step 8 — Evidence-Linked AI Copilot
- **Screen:** Overview (`/`) — AI Audit Copilot panel
- **Action:** Ask: `"Why is Supplier A's invoice flagged?"`
- **Expected Result:** Returns an evidence-linked answer citing actual database records: `20 kg` quantity discrepancy, `PO-101` `Rs 500 -> Rs 700` unapproved change by `Employee 102`, historical extra charges (`500, 700, 1000`), `Rs 9,000` ITC at risk, and `SHARED_BANK` indicator.

### Step 9 — Auto-Assigned Investigations & Maker-Checker Block
- **Screen:** Investigation Center (`/investigations`) & Approvals & Guard (`/approvals`)
- **Action:**
  1. Verify investigations are auto-assigned across `WAREHOUSE`, `PROCUREMENT & FINANCE`, `AP & FINANCE`, and `FINANCE & COMPLIANCE`.
  2. Sign in as **Employee 102** (`employee102@abcmfg.sample`), submit a PO price change request on `/approvals`, and click **Approve** on your own request.
- **Expected Result:**
  - Server returns `403 Maker-checker violation`.
  - Attempting to approve payment on `INV-101` returns `409` while any investigation remains open.

### Step 10 — GRN Resolution, Revalidation, Audit Log Verify & Human Final Approval
- **Screen:** GRNs (`/grns`), Investigation Center (`/investigations`), Invoices (`/invoices/:id`), Audit Log (`/audit-log`)
- **Action:**
  1. Sign in as **Warehouse Employee** (`warehouse@abcmfg.sample`), record a partial `+20 kg` GRN on `PO-101` in `/grns`, and resolve the `WAREHOUSE` quantity investigation (`IN_PROGRESS -> RESOLVED`). Observe automatic pipeline revalidation transitioning it to `REVALIDATED` (note: resolving *before* adding the GRN automatically sets it to `REOPENED`).
  2. Sign in as **Finance Manager**, resolve/revalidate remaining cases and approve high-risk payment (`ELIGIBLE_FOR_APPROVAL -> APPROVED` only after all investigations are `REVALIDATED`).
  3. Sign in as **Admin** (`admin@abcmfg.sample`), open **Audit Log**, and click **Verify Chain**.
- **Expected Result:** SHA-256 hash chain passes integrity verification (`valid: true`).
