# FINSHIELD AI

> **Beyond Invoice Matching: Catch Financial Risk and GST Loss Before You Pay.**

AI-powered Accounts Payable (AP) Risk & GST Compliance Platform for Indian businesses.

> **Sample Data Notice:** All seeded records in Phase 1 belong to the fictional company **ABC Manufacturing (Sample)** and are marked `is_sample_data = TRUE`.

---

## Folder Structure

- `/backend` — Node.js + Express + TypeScript API server (`GET /api/health`, CORS, dotenv, error handling)
- `/frontend` — React + TypeScript + Vite + Tailwind CSS v4 frontend
- `/database` — PostgreSQL SQL migrations (`migrations/001_initial_schema.sql`), migration runner (`migrate.ts`), and sample seed script (`seed.ts`)
- `/sample-data` — Reference sample scenario data (`demo_scenario.json`)
- `/docs` — Schema and architecture documentation (`schema.md`)

---

## Prerequisites

- **Node.js** >= 20
- **PostgreSQL** >= 15

---

## Setup & Installation

### 1. Configure Environment Variables

Copy `.env.example` to `.env` (and/or `backend/.env`) and set your PostgreSQL connection string:

```bash
cp .env.example .env
cp backend/.env.example backend/.env
```

Update `DATABASE_URL` in `.env` and `backend/.env`, for example:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/finshield_ai"
JWT_SECRET="replace-with-strong-random-secret"
LLM_API_KEY="YOUR_API_KEY"
PORT=4000
```

Create the PostgreSQL database if it does not exist yet:

```bash
createdb finshield_ai
```

### 2. Install Dependencies

Install dependencies for backend and frontend (or at the project root for the combined preview):

```bash
# Root (optional unified workspace)
npm install

# Backend
cd backend && npm install && cd ..

# Frontend
cd frontend && npm install && cd ..
```

### 3. Run Database Migrations

```bash
cd backend && npm run migrate
```

*(Or from project root: `npm run migrate`)*

### 4. Seed the Sample Demo Scenario (ABC Manufacturing)

```bash
cd backend && npm run seed
```

*(Or from project root: `npm run seed`)*

### 5. Run Backend & Frontend

**Option A — Run Backend and Frontend Separately:**

Terminal 1 (Backend on port `4000`):
```bash
cd backend && npm run dev
```

Terminal 2 (Frontend on port `5173`, proxying `/api` to `localhost:4000`):
```bash
cd frontend && npm run dev
```

**Option B — Unified Preview Server (Port `3000`):**

```bash
npm run dev
```

---

## Verify Health Check & Seed Data

1. Open `http://localhost:5173` (or `http://localhost:3000`) in your browser — the placeholder home page calls `GET /api/health` and displays backend & PostgreSQL connectivity along with the **Sample data** banner.
2. You can also check the backend API directly:
   ```bash
   curl http://localhost:4000/api/health
   ```
3. Verify the seeded demo records in PostgreSQL using `psql`:
   ```sql
   SELECT
     po.po_number,
     po.original_total,
     po.current_total,
     po.status AS po_status,
     pl.original_unit_price,
     pl.current_unit_price,
     pch.field AS changed_field,
     pch.old_value,
     pch.new_value,
     u.name AS changed_by_user,
     pch.approval_id,
     g.grn_number,
     gl.quantity_received,
     i.invoice_number,
     il.quantity AS invoiced_qty,
     il.unit_price AS invoiced_unit_price,
     i.total AS invoice_total,
     s.name AS supplier_name,
     s.bank_identifier
   FROM purchase_orders po
   JOIN suppliers s ON s.id = po.supplier_id
   JOIN po_lines pl ON pl.po_id = po.id
   LEFT JOIN po_change_history pch ON pch.po_id = po.id
   LEFT JOIN users u ON u.id = pch.changed_by
   LEFT JOIN grns g ON g.po_id = po.id
   LEFT JOIN grn_lines gl ON gl.grn_id = g.id
   LEFT JOIN invoices i ON i.po_id = po.id
   LEFT JOIN invoice_lines il ON il.invoice_id = i.id
   WHERE po.po_number = 'PO-101';
   ```
