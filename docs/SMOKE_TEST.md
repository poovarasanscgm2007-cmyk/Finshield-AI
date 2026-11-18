# FINSHIELD AI — End-to-End Smoke Test Runbook (Phases 1–5)

## Commands
Run the automated smoke test against the running server (port `3000` by default) or directly with `DATABASE_URL` configured:

```bash
npm run smoke
```

Reset the database to the clean initial demo seed (with `PO-101`'s `UNAPPROVED` change and active `INV-101` investigations):

```bash
npm run reset-demo
```

Optional custom target URL:

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 npm run smoke
```

## Checks Executed
1. **Health Check (`GET /api/health`)** — Confirms Express API and PostgreSQL connection are healthy (`200 OK`).
2. **Authentication (`POST /api/auth/login`)** — Logs in all 5 sample roles (`AP_EMPLOYEE`, `PROCUREMENT_EMPLOYEE`, `WAREHOUSE_EMPLOYEE`, `FINANCE_MANAGER`, `ADMIN`) and verifies JWT issuance.
3. **RBAC Enforcement (`403 Forbidden`)** — Confirms `WAREHOUSE_EMPLOYEE` receives `403` on `/api/audit-log`, `POST /api/invoices/upload`, and `POST /api/invoices/:id/match`; and `FINANCE_MANAGER` receives `403` on `POST /api/invoices/upload`.
4. **Maker-Checker Guard (`POST /api/approvals` + `/approve`)** — Confirms requester (`Employee 102`) cannot approve their own request (`403 Maker-checker violation`), `ADMIN` cannot approve (`403`), `FINANCE_MANAGER` can approve (`200`), and `PO-101`'s seeded `UNAPPROVED` change remains intact.
5. **Audit Log Integrity (`GET /api/audit-log/verify`)** — Verifies SHA-256 hash chain across all audit log entries (`valid: true`).
6. **Clean Invoice Extraction (`POST /api/invoices/upload`)** — Uploads `/sample-data/invoices/INV-101-sample.pdf` as `AP_EMPLOYEE`, verifies extracted `INV-101`, normalized `INV101`, `PO-101`, GSTIN `27AABCS5678C1Z9`, `subtotal: 50000`, `total: 59000`, per-field confidences, and `GET /api/invoices/:id/file` document preview.
7. **Scanned OCR + Verification + Auto-Match (`POST /api/invoices/upload` + `PUT /api/invoices/:id/verify`)** — Uploads `/sample-data/invoices/INV-099-scanned-sample.pdf`, verifies `TESSERACT_OCR` extraction, confirms `PUT /api/invoices/:id/verify` records verification (`VERIFIED`), auto-runs 3-way matching (`HOLD` -> `ON_HOLD` when PO is missing), and updates the hash-chained `audit_log`.
8. **3-Way Matching & Duplicate Detection (`POST /api/invoices/:id/match`, `GET /api/invoices/:id/match-result`, `GET /api/invoices/:id/duplicates`, `GET /api/invoices/summary`)** — Confirms `INV-101` evaluates to `MISMATCH`/`ON_HOLD` against approved PO unit price `500` with reason `"Invoice qty 100 exceeds received qty 80 by 20"`, flags seeded `INV_101` as `POSSIBLE DUPLICATE`, verifies summary metrics, and keeps `PO-101`'s `UNAPPROVED` change untouched.
9. **Phase 5 Investigation Workflow, Revalidation, Payment Gate, Dashboard & AI Copilot**:
   - Verifies idempotent investigation auto-creation across departments (`WAREHOUSE`, `PROCUREMENT & FINANCE`, `AP & FINANCE`, `FINANCE & COMPLIANCE`).
   - Confirms `WAREHOUSE_EMPLOYEE` receives `403` attempting to transition `GST_ITC_RISK` (`FINANCE & COMPLIANCE`).
   - Confirms payment approval is blocked (`409`) while any investigation is not `REVALIDATED`.
   - Verifies `POST /api/copilot/ask` answers `"Why is Supplier A's invoice flagged?"` with cited DB evidence and exact metrics (`20 kg`, `Rs 500`, `Rs 700`, extra charges, `Rs 9,000` ITC at risk), and enforces RBAC filtering for Warehouse.
   - Verifies `PUT /api/investigations/:id/status` with `RESOLVED` re-runs the full pipeline: premature resolution yields `REOPENED`; resolving after recording the missing `20 kg` GRN (`POST /api/grns`) yields `REVALIDATED` while other issues stay `OPEN` and `INV-101` remains `ON_HOLD`.
   - Verifies `GET /api/dashboard/metrics` (7 KPIs, 3 chart datasets, `recentAlerts`) and restores the clean seeded demo state via `POST /api/system/reset-demo`.
