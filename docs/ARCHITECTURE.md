# FINSHIELD AI — System Architecture & ERP Integration Pattern

## 1. High-Level Architecture

```
+-----------------------------------------------------------------------+
|                    Frontend SPA (React + TypeScript)                  |
|  Vite + Tailwind CSS v4 + Recharts + react-force-graph-2d             |
|  Role-Based UI: Overview | Invoices | Approvals | Investigations |    |
|  Supplier Graph | Suppliers & Scorecards | Audit Log | Demo Guide     |
+-----------------------------------+-----------------------------------+
                                    | HTTPS / JSON + JWT Bearer Auth
                                    v
+-----------------------------------------------------------------------+
|                Backend API (Node.js + Express + TypeScript)           |
|  Middleware: authenticate (JWT 8h) -> requireRole(...) -> errorHandler |
|  Services:                                                            |
|   - extractionService (PDFJS + Tesseract.js OCR + Gemini/Regex)       |
|   - matchingService (3-Way PO + Summed GRNs + Invoice)                |
|   - duplicateService (Normalized Invoice # + Multi-factor similarity) |
|   - gstValidation + riskPipelineService (Rules, Weights, ITC at Risk) |
|   - investigationService (Auto-routing, Revalidation, Payment Gate)   |
|   - approvalService (Maker-Checker Guard, PO Price & Bank Change)     |
|   - supplierService (PG Graph Queries, Scorecards, Bank Masking)      |
|   - copilotService (Evidence-Linked DB Retrieval + Gemini/Fallback)   |
|   - auditService (Append-Only SHA-256 Hash Chain)                     |
+-----------------------------------+-----------------------------------+
                                    | pg Pool (Parameterized SQL)
                                    v
+-----------------------------------------------------------------------+
|                    PostgreSQL Relational Database                     |
|  Tables: users, suppliers, purchase_orders, po_lines, po_change_log,  |
|  grns, grn_lines, invoices, invoice_lines, extraction_confidence,     |
|  match_results, gstr2b_records, risk_rules_config, risk_flags,        |
|  approvals, investigations, investigation_comments,                   |
|  investigation_evidence, audit_log (hash-chained)                     |
+-----------------------------------------------------------------------+
```

---

## 2. Core Design Decisions

1. **PostgreSQL Over Dedicated Graph DB (No Neo4j):**
   - Supplier relationship edges (`SHARED_BANK`, `SHARED_ADDRESS`, `SHARED_PHONE`, `SHARED_PAN_PATTERN`) are computed directly from normalized SQL attributes in `suppliers`, joined to `investigations` and `risk_flags`, and visualized interactively with `react-force-graph-2d`.
2. **Explainable Rule Engine & Configurable Thresholds:**
   - All tolerances (`match_qty_tolerance_pct`, `match_price_tolerance_pct`), confidence thresholds (`extraction_confidence_threshold`), duplicate thresholds (`duplicate_similarity_threshold`), and rule weights live in `risk_rules_config`.
   - Every risk flag stores exact `reason` text, `score`, and `metadata` JSONB so humans and the AI Copilot inspect evidence rather than black-box scores.
3. **Tamper-Evident Audit Chain & Maker-Checker Separation:**
   - Every sensitive mutation computes `SHA-256(prev_hash | timestamp | actor_id | action | entity | entity_id | payload)` inside the transaction.
   - `approvalService` rejects self-approval (`403 Maker-checker violation`) and restricts PO price changes and supplier bank changes to `FINANCE_MANAGER`.

---

## 3. ERP Integration Adapter Pattern (Future SAP / Tally / Zoho Connectors)

FINSHIELD AI complements existing ERPs rather than replacing them. Today, POs, GRNs, invoices, and GSTR-2B datasets enter via **seeded/CSV-compatible ingestion and upload APIs**. Production ERP connectivity follows a clean **Adapter Pattern**:

```ts
export interface ErpPurchaseOrder {
  poNumber: string;
  supplierCode: string;
  currency: string;
  lines: Array<{ description: string; quantity: number; unit: string; unitPrice: number }>;
}

export interface ErpGrnRecord {
  grnNumber: string;
  poNumber: string;
  receivedDate: string;
  warehouseLocation: string;
  lines: Array<{ description: string; quantityReceived: number; unit: string }>;
}

export interface ErpAdapter {
  readonly systemName: 'CSV_IMPORT' | 'SAP_S4HANA' | 'TALLY_PRIME' | 'ZOHO_BOOKS';
  fetchPurchaseOrders(sinceIso?: string): Promise<ErpPurchaseOrder[]>;
  fetchGoodsReceipts(poNumber?: string): Promise<ErpGrnRecord[]>;
  pushApprovedPaymentHoldStatus(invoiceNumber: string, status: 'ON_HOLD' | 'APPROVED'): Promise<void>;
}
```

- **Current Prototype (`CsvImportAdapter`):** Parses standardized CSV exports or seeded sample records into PostgreSQL (`purchase_orders`, `grns`, `gstr2b_records`).
- **Planned Production Adapters:**
  - `SapODataAdapter`: Connects via SAP S/4HANA OData / REST APIs (`API_PURCHASEORDER_PROCESS_SRV`, `API_MATERIAL_DOCUMENT_SRV`).
  - `TallyXmlRestAdapter`: Polls TallyPrime HTTP XML/JSON gateway for vouchers, ledgers, and stock receipts.
  - `GspGstAdapter`: Syncs real GSTR-2B JSON payloads via licensed GST Suvidha Provider APIs.
