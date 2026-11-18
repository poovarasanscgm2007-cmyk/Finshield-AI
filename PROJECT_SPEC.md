# FINSHIELD AI: Project Specification

## 1. Overview
FINSHIELD AI is an AI-powered Accounts Payable (AP) Risk & GST Compliance Platform for Indian businesses (hackathon prototype). It automates invoice extraction, 3-way matching (PO, GRN, Invoice), detects duplicates, suspicious patterns and GST/ITC risk, and gives evidence-based AI investigation. It complements ERP systems; it does not replace them.
Tagline: "Beyond Invoice Matching: Catch Financial Risk and GST Loss Before You Pay."

## 2. Golden rules (apply to EVERY task)
1. NO fake buttons, NO hardcoded results. Features 1 to 8 below must have real working logic.
2. AI NEVER releases payment. Final payment approval is always a human with the right role.
3. Risk score = investigation priority, NOT a fraud verdict. Every score must show a list of reasons. Rules and weights must be configurable.
4. All demo data is SAMPLE data and must be clearly labelled "Sample data" in the UI.
5. Every important action is written to a hash-chained audit log.
6. Implement only the phase requested. Do not touch unrelated modules.
7. After each task: list changed files, how to run, how to test.

## 3. Tech stack (final)
- Frontend: React + TypeScript (Vite), Recharts, react-force-graph, TailwindCSS
- Backend: Node.js + Express + TypeScript
- Database: PostgreSQL (use Prisma or plain SQL migrations)
- OCR: Tesseract (tesseract.js) with LLM API for field extraction; per-field confidence score
- Rule engine: TypeScript in backend (explainable rules, configurable thresholds)
- No Neo4j. Supplier graph uses PostgreSQL queries + react-force-graph.
- ERP integration: CSV import now; adapter-pattern REST structure for SAP/Tally later.

## 4. Roles
AP Employee, Procurement Employee, Warehouse Employee, Finance Manager, Admin. Role-based access on every API and every UI route.

## 5. Features
Real logic (must work):
1. Invoice upload + OCR/AI extraction with confidence per field; low-confidence fields need human verification.
2. 3-way matching: PO, GRN (multiple GRNs allowed, sum quantities), Invoice. Compare product, quantity, unit price, tax. Configurable tolerance (default 2%). Output: MATCHED / MISMATCH / HOLD with exact reason text.
3. Duplicate detection: normalize invoice numbers (INV-123, INV 123, INV_123 are same); also compare supplier, date, amount, line items, and e-invoice IRN. Output "possible duplicate" with similarity score; never auto-reject.
4. PO change monitoring: store original PO price/qty, track every modification (who, when, old, new), check for approval record, flag unapproved changes.
5. Historical overbilling: detect repeated extra charges and unusual price changes per supplier across past invoices.
6. GST checks: GSTIN format + checksum validation (15 chars: 2-digit state code, 10-char PAN, entity digit, 'Z', checksum), tax calculation check (same state => CGST+SGST, different state => IGST), GSTR-2B vs purchase register mismatch, supplier filing status risk, "ITC at risk" amount in INR.
7. AI Copilot: natural-language questions (e.g. "Why is Supplier A's invoice flagged?"). Answers must be evidence-linked, using actual database records, never invented data.
8. FINSHIELD GUARD: RBAC, maker-checker (creator cannot approve own change), hash-chained audit log (each record stores hash of previous record), multi-level approval for high-risk items.
Labelled sample data allowed:
9. Supplier relationship graph (e.g. Supplier A and B share a bank identifier). This is an indicator for verification, not proof of fraud.
10. Supplier scorecard.
11. Investigation workflow: create issue, auto-assign department (Quantity mismatch => Warehouse; Price/PO change => Procurement/Finance; Duplicate/Overbilling => AP/Finance; Supplier or GST risk => Finance/Compliance), status tracking, revalidation after resolution.

## 6. Demo scenario (seed data)
Company: ABC Manufacturing (sample). Supplier A supplies wood.
- PO-101: 100 kg wood, Rs 500/kg
- GRN-101: 80 kg received
- INV-101: 100 kg billed, Rs 500/kg
Planted problems:
- Quantity mismatch: invoice 100 kg vs received 80 kg (20 kg difference)
- PO-101 price modified Rs 500 to Rs 700 by Employee 102, no approval record
- Supplier A has history of repeated extra charges (Rs 500, Rs 700, Rs 1000) across past invoices
- Supplier A and Supplier B share the same bank identifier
- INV-101 not present in sample GSTR-2B => ITC at risk
Demo flow: login by role, upload invoice, extraction, matching, GST check, risk alerts, graph, Copilot, auto-assignment, maker-checker block, resolution and revalidation, human final approval.

## 7. Quality bar
- Clean folder structure: /backend, /frontend, /database, /sample-data, /docs
- Environment variables in .env (never commit secrets), provide .env.example
- Basic tests for matching, duplicate, GST checksum and hash-chain logic using the demo data
- Clear error handling; app must not crash during demo
