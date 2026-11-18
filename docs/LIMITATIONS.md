# FINSHIELD AI — Known Limitations & Responsible Use

1. **Hackathon Prototype & Sample Data**
   - FINSHIELD AI is a functional prototype built for demonstration and evaluation. All company, supplier, purchase order, GRN, invoice, and GSTR-2B records belong to the fictional **ABC Manufacturing (Sample)** dataset and are clearly labeled **Sample data** across the UI.

2. **GSTN / GSTR-2B Integration Uses Sample Data (GSP Required for Production)**
   - In this prototype, GSTR-2B reconciliation checks invoices against the local `gstr2b_records` PostgreSQL sample table.
   - Production deployment in India requires licensed **GST Suvidha Provider (GSP)** / NIC e-Invoice IRP API integration, taxpayer OAuth/consent credentials, and periodic reconciliation syncs.

3. **OCR & LLM Extraction Can Err — Human Verification Required**
   - Digital PDF text parsing (`pdfjs-dist`), scanned image OCR (`tesseract.js`), and LLM extraction (`@google/genai` with deterministic regex fallback) can misread low-resolution scans, stamps, handwritten notes, or non-standard layouts.
   - Any extracted field below the configurable confidence threshold (default `0.80`) or missing enters `NEEDS_VERIFICATION` and requires explicit **AP Employee** human verification before matching.

4. **Risk Score Is Investigation Priority, Not a Fraud Verdict**
   - Rule scores (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`) and supplier scorecard grades (`A`–`F`) measure **investigation priority** and operational performance only.
   - Shared supplier attributes (e.g., `SHARED_BANK`, `SHARED_ADDRESS`, `SHARED_PHONE`) are **indicators requiring verification**—for example, sibling subsidiaries or shared logistics partners—and are never proof of fraud.

5. **AI Never Releases Payment**
   - Neither the extraction pipeline, rule engine, nor AI Audit Copilot can approve or disburse payments.
   - High-risk invoices require multi-level human approvals, maker-checker separation, and `REVALIDATED` completion across all linked investigations before a **Finance Manager** can grant final payment approval.

6. **Single-Tenant Prototype ERP & Auth Scope**
   - Authentication uses local email/password + JWT (`8h` expiry) with five sample roles rather than enterprise SSO/SAML.
   - ERP integration currently supports seeded/manual/CSV-compatible ingestion with a clean adapter pattern designed for SAP, Tally, or Zoho Books REST connectors in future production phases.
