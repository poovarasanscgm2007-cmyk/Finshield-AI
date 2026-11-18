# FINSHIELD AI

> **Beyond Invoice Matching: Catch Financial Risk and GST Loss Before You Pay.**

AI-powered Accounts Payable (AP) Risk & GST Compliance Platform for Indian businesses.

---

## Sample data

All seeded records belong to the fictional company **ABC Manufacturing (Sample)** and are marked `is_sample_data = TRUE`. A visible **Sample data** notice is displayed throughout the application.

### Demo Logins (Sample Users)

| Employee Code | Name | Role | Email | Demo Password |
| :--- | :--- | :--- | :--- | :--- |
| `EMP-101` | Aarav Mehta (Sample AP Employee) | `AP_EMPLOYEE` | `ap.employee@abcmfg.sample` | `SamplePass@101` |
| `EMP-102` | Employee 102 | `PROCUREMENT_EMPLOYEE` | `employee102@abcmfg.sample` | `SamplePass@102` |
| `EMP-103` | Rohan Verma (Sample Warehouse Employee) | `WAREHOUSE_EMPLOYEE` | `warehouse@abcmfg.sample` | `SamplePass@103` |
| `EMP-104` | Priya Nair (Sample Finance Manager) | `FINANCE_MANAGER` | `finance.manager@abcmfg.sample` | `SamplePass@104` |
| `EMP-105` | Vikram Rao (Sample Admin) | `ADMIN` | `admin@abcmfg.sample` | `SamplePass@105` |

Sample PDFs for upload testing are in `/sample-data/invoices/`:
- `INV-101-sample.pdf` (digital PDF with embedded text)
- `INV-098-sample.pdf` (digital PDF with extra charges)
- `INV-099-scanned-sample.pdf` (scanned image PDF routed through Tesseract OCR)

---

## Folder Structure

- `/backend` — Node.js + Express + TypeScript API server (Auth, RBAC, OCR/AI Extraction, 3-Way Matching, Duplicate Detection, GST & Risk Pipeline, Investigation Workflow, AI Copilot, Supplier Graph & Scorecards, Hash-Chained Audit Log)
- `/frontend` — React + TypeScript + Vite + Tailwind CSS v4 + Recharts + `react-force-graph-2d`
- `/database` — PostgreSQL SQL migrations (`001`–`005`), migration runner (`migrate.ts`), and sample seed script (`seed.ts`)
- `/sample-data` — Reference scenario JSON and sample invoice PDFs (`/sample-data/invoices`)
- `/docs` — `DEMO_SCRIPT.md`, `LIMITATIONS.md`, `ARCHITECTURE.md`, `SMOKE_TEST.md`, `schema.md`

---

## Setup, Migration, Seed & Run

### 1. Configure Environment Variables

```bash
cp .env.example .env
cp backend/.env.example backend/.env
```

Set `DATABASE_URL`, `JWT_SECRET`, `LLM_API_KEY`, and `PORT` in `.env` and `backend/.env`.

### 2. Install Dependencies

```bash
npm install
```

### 3. Migrate, Seed & Reset Demo Data

```bash
npm run migrate
npm run seed
npm run reset-demo
```

### 4. Start the Application

**Unified preview server (port 3000 — serves API + Frontend):**
```bash
npm run dev
```

**Or separate dev servers:**
```bash
# Terminal 1 (Backend on port 4000)
cd backend && npm run dev

# Terminal 2 (Frontend on port 5173)
cd frontend && npm run dev
```

---

## Test & Verification Commands

Run each verification suite sequentially:

```bash
npm run reset-demo   # Restore clean sample data & evaluate INV-101
npm test             # Unit & DB integration tests (phases 2-6)
npm run smoke        # End-to-end API smoke test across RBAC roles
npm run demo-test    # Expected-output verification for all 10 planted demo assertions
```

---

## 10-Step Demo Order

See `/docs/DEMO_SCRIPT.md` or log in as **Admin** / **Finance Manager** and open the **Demo Guide** page (`/demo-guide`):

1. Role-based login (`AP Employee` / Quick Login) & RBAC verification
2. Upload sample invoice (`INV-101-sample.pdf` or scanned `INV-099-scanned-sample.pdf`)
3. Human verification of low-confidence fields & normalized duplicate detection (`INV-101` vs `INV_101`)
4. 3-way matching (`PO-101` vs `GRN-101` vs `INV-101`: `100` billed vs `80` received -> `ON_HOLD`)
5. GSTIN checksum, intra-state CGST+SGST check & GSTR-2B mismatch (`Rs 9,000` ITC at risk)
6. Explainable risk alerts (`HIGH` investigation priority) & Supplier Scorecard (`/suppliers`)
7. Supplier Relationship Graph (`SHARED_BANK` `XXXX8877` indicator requiring verification) (`/supplier-graph`)
8. Evidence-linked AI Audit Copilot (`"Why is Supplier A's invoice flagged?"`)
9. Auto-assigned department investigations & Maker-Checker block (`Employee 102` gets `403`)
10. Warehouse GRN resolution (`+20 kg`), automatic revalidation, Admin hash-chain audit verify, and Finance Manager human final payment approval
