# FINSHIELD AI — End-to-End Smoke Test Runbook (Phases 1–3)

## Command
Run the automated smoke test against the running server (port `3000` by default) or directly with `DATABASE_URL` configured:

```bash
npm run smoke
```

Optional custom target URL:

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 npm run smoke
```

## Checks Executed
1. **Health Check (`GET /api/health`)** — Confirms Express API and PostgreSQL connection are healthy (`200 OK`).
2. **Authentication (`POST /api/auth/login`)** — Logs in all 5 sample roles (`AP_EMPLOYEE`, `PROCUREMENT_EMPLOYEE`, `WAREHOUSE_EMPLOYEE`, `FINANCE_MANAGER`, `ADMIN`) and verifies JWT issuance.
3. **RBAC Enforcement (`403 Forbidden`)** — Confirms `WAREHOUSE_EMPLOYEE` receives `403` on `/api/audit-log` and `POST /api/invoices/upload`, and `FINANCE_MANAGER` receives `403` on `POST /api/invoices/upload`.
4. **Maker-Checker Guard (`POST /api/approvals` + `/approve`)** — Confirms requester (`Employee 102`) cannot approve their own request (`403 Maker-checker violation`), `ADMIN` cannot approve (`403`), `FINANCE_MANAGER` can approve (`200`), and `PO-101`'s seeded `UNAPPROVED` change remains intact.
5. **Audit Log Integrity (`GET /api/audit-log/verify`)** — Verifies SHA-256 hash chain across all audit log entries (`valid: true`).
6. **Clean Invoice Extraction (`POST /api/invoices/upload`)** — Uploads `/sample-data/invoices/INV-101-sample.pdf` as `AP_EMPLOYEE`, verifies extracted `INV-101`, normalized `INV101`, `PO-101`, GSTIN `27AABCS5678C1Z9`, `subtotal: 50000`, `total: 59000`, per-field confidences, and `GET /api/invoices/:id/file` document preview.
7. **Scanned OCR + Verification (`POST /api/invoices/upload` + `PUT /api/invoices/:id/verify`)** — Uploads `/sample-data/invoices/INV-099-scanned-sample.pdf`, verifies `TESSERACT_OCR` extraction, confirms `PUT /api/invoices/:id/verify` sets status `VERIFIED` and records diff to the hash-chained `audit_log`.
