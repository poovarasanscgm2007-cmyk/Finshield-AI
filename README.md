# FINSHIELD AI

> **Beyond Invoice Matching: Catch Financial Risk and GST Loss Before You Pay.**

AI-powered Accounts Payable (AP) Risk & GST Compliance Platform for Indian businesses.

---

## Sample data

All seeded records belong to the fictional company **ABC Manufacturing (Sample)** and are marked `is_sample_data = TRUE`.

### Demo Logins (Sample Users)

| Employee Code | Name | Role | Email | Demo Password |
| :--- | :--- | :--- | :--- | :--- |
| `EMP-101` | Aarav Mehta (Sample AP Employee) | `AP_EMPLOYEE` | `ap.employee@abcmfg.sample` | `SamplePass@101` |
| `EMP-102` | Employee 102 | `PROCUREMENT_EMPLOYEE` | `employee102@abcmfg.sample` | `SamplePass@102` |
| `EMP-103` | Rohan Verma (Sample Warehouse Employee) | `WAREHOUSE_EMPLOYEE` | `warehouse@abcmfg.sample` | `SamplePass@103` |
| `EMP-104` | Priya Nair (Sample Finance Manager) | `FINANCE_MANAGER` | `finance.manager@abcmfg.sample` | `SamplePass@104` |
| `EMP-105` | Vikram Rao (Sample Admin) | `ADMIN` | `admin@abcmfg.sample` | `SamplePass@105` |

---

## Folder Structure

- `/backend` — Node.js + Express + TypeScript API server (Auth, RBAC, Maker-Checker Approvals, PO Price Change Guard, Hash-Chained Audit Log)
- `/frontend` — React + TypeScript + Vite + Tailwind CSS v4 frontend
- `/database` — PostgreSQL SQL migrations (`001_initial_schema.sql`, `002_phase2_guard_and_audit.sql`), migration runner (`migrate.ts`), and sample seed script (`seed.ts`)
- `/sample-data` — Reference sample scenario data (`demo_scenario.json`)
- `/docs` — Schema and architecture documentation (`schema.md`)

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
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

### 3. Migrate & Seed

```bash
npm run migrate
npm run seed
```

### 4. Run Backend & Frontend

**Separate dev servers:**
```bash
# Terminal 1 (Backend on port 4000)
cd backend && npm run dev

# Terminal 2 (Frontend on port 5173)
cd frontend && npm run dev
```

**Unified preview server (port 3000):**
```bash
npm run dev
```

### 5. Run Tests

```bash
npm test
```

---

## Verify Phase 2 via Curl

```bash
# 1. Login as Employee 102 (Procurement)
EMP_TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"employee102@abcmfg.sample","password":"SamplePass@102"}' | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.token)")

# 2. Request PO-101 price change (500 -> 700) — creates PENDING approval
APPROVAL_ID=$(curl -s -X PUT http://localhost:4000/api/purchase-orders/1/price \
  -H "Authorization: Bearer $EMP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"newUnitPrice":700,"reason":"Test price change request"}' | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.approval.id)")

# 3. Maker-checker block: Employee 102 tries to approve own request (returns 403)
curl -i -X POST http://localhost:4000/api/approvals/$APPROVAL_ID/approve \
  -H "Authorization: Bearer $EMP_TOKEN"

# 4. Login as Finance Manager and approve
FM_TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"finance.manager@abcmfg.sample","password":"SamplePass@104"}' | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.token)")

curl -i -X POST http://localhost:4000/api/approvals/$APPROVAL_ID/approve \
  -H "Authorization: Bearer $FM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"remarks":"Approved by Finance Manager"}'

# 5. Verify hash-chained audit log
curl -s http://localhost:4000/api/audit-log/verify \
  -H "Authorization: Bearer $FM_TOKEN"
```
