import fs from 'fs';
import path from 'path';
import { env } from '../config/env.ts';
import { getPool, query } from '../db/pool.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { isValidIsoDate, normalizeInvoiceNumber } from '../utils/invoiceNormalizer.ts';
import { writeAuditLog } from './auditService.ts';
import { getDuplicateFlagsByInvoice } from './duplicateService.ts';
import { extractStructuredInvoice, StructuredInvoiceExtraction } from './llmInvoiceExtractor.ts';
import { syncAndEvaluateInvoice } from './investigationService.ts';
import { StoredMatchResultRecord } from './matchingService.ts';
import { extractTextFromDocument } from './ocrTextExtractor.ts';

export interface InvoiceRecord {
  id: number;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  irn: string | null;
  supplier_id: number | null;
  supplier_name?: string | null;
  supplier_name_extracted: string | null;
  supplier_gstin_extracted: string | null;
  po_id: number | null;
  po_number?: string | null;
  po_reference_extracted: string | null;
  bank_identifier_extracted: string | null;
  invoice_date: string | null;
  subtotal: string | null;
  cgst: string | null;
  sgst: string | null;
  igst: string | null;
  extra_charges: string;
  total: string | null;
  status: string;
  extraction_confidence: Record<string, unknown>;
  extraction_source: string | null;
  extraction_method: string | null;
  raw_extracted_text?: string | null;
  original_extracted_data: Record<string, unknown> | null;
  verified_data: Record<string, unknown> | null;
  verified_by: number | null;
  verified_by_name?: string | null;
  verified_at: string | null;
  file_path: string | null;
  mime_type: string | null;
  original_filename: string | null;
  file_size_bytes: number | null;
  is_historical: boolean;
  is_sample_data: boolean;
  created_at: string;
  match_status?: string | null;
  match_reasons?: string[] | null;
  possible_duplicate?: boolean;
  duplicate_score?: number;
  duplicate_reasons?: string[];
  risk_score?: string;
  risk_level?: string;
  itc_at_risk?: string;
  level1_approved_by?: number | null;
  level1_approved_by_name?: string | null;
  level1_approved_at?: string | null;
  payment_approved_by?: number | null;
  payment_approved_by_name?: string | null;
  payment_approved_at?: string | null;
}

export interface InvoiceLineRecord {
  id: number;
  invoice_id: number;
  line_number: number;
  description: string;
  hsn_sac: string | null;
  quantity: string;
  unit: string;
  unit_price: string;
  extra_charge: string;
  tax_rate: string;
  line_total: string;
}

export async function createAndExtractInvoice(params: {
  fileBuffer: Buffer;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  storedRelativePath: string;
  uploadedBy: number;
}): Promise<{ invoice: InvoiceRecord; lines: InvoiceLineRecord[]; extraction: StructuredInvoiceExtraction }> {
  const pool = getPool();

  // Step 1: Create initial invoice record in EXTRACTING state + audit log
  const createClient = await pool.connect();
  let invoiceId: number;
  try {
    await createClient.query('BEGIN');

    const insertRes = await createClient.query<{ id: number }>(
      `
      INSERT INTO invoices (
        status, file_path, mime_type, original_filename, file_size_bytes,
        uploaded_by, is_historical, is_sample_data
      )
      VALUES ('EXTRACTING', $1, $2, $3, $4, $5, FALSE, TRUE)
      RETURNING id;
      `,
      [
        params.storedRelativePath,
        params.mimeType,
        params.originalFilename,
        params.fileSize,
        params.uploadedBy,
      ]
    );

    invoiceId = insertRes.rows[0].id;

    await writeAuditLog(
      params.uploadedBy,
      'INVOICE_UPLOADED',
      'invoices',
      invoiceId,
      {
        originalFilename: params.originalFilename,
        mimeType: params.mimeType,
        fileSize: params.fileSize,
        status: 'EXTRACTING',
      },
      createClient
    );

    await createClient.query('COMMIT');
  } catch (err) {
    await createClient.query('ROLLBACK');
    throw err;
  } finally {
    createClient.release();
  }

  // Step 2: Run OCR / PDF text extraction + LLM (with regex fallback)
  const textResult = await extractTextFromDocument(params.fileBuffer, params.mimeType);
  const extraction = await extractStructuredInvoice(textResult);

  // Step 3: Persist extracted fields, line items, and confidence scores
  const updateClient = await pool.connect();
  try {
    await updateClient.query('BEGIN');

    // Attempt non-destructive lookup of supplier_id and po_id if present in DB
    let matchedSupplierId: number | null = null;
    if (extraction.fields.supplier_gstin) {
      const supRes = await updateClient.query<{ id: number }>(
        'SELECT id FROM suppliers WHERE UPPER(gstin) = $1 LIMIT 1',
        [extraction.fields.supplier_gstin.toUpperCase()]
      );
      matchedSupplierId = supRes.rows[0]?.id ?? null;
    }

    let matchedPoId: number | null = null;
    if (extraction.fields.po_reference) {
      const poRes = await updateClient.query<{ id: number }>(
        'SELECT id FROM purchase_orders WHERE UPPER(po_number) = $1 LIMIT 1',
        [extraction.fields.po_reference.toUpperCase()]
      );
      matchedPoId = poRes.rows[0]?.id ?? null;
    }

    const originalSnapshot = {
      ...extraction.fields,
      lineItems: extraction.lineItems,
      extractionSource: extraction.extractionSource,
      extractionMethod: extraction.extractionMethod,
    };

    const updatedRes = await updateClient.query<InvoiceRecord>(
      `
      UPDATE invoices
      SET invoice_number = $1,
          normalized_invoice_number = $2,
          irn = $3,
          supplier_id = $4,
          supplier_name_extracted = $5,
          supplier_gstin_extracted = $6,
          po_id = $7,
          po_reference_extracted = $8,
          bank_identifier_extracted = $9,
          invoice_date = $10::date,
          subtotal = $11,
          cgst = $12,
          sgst = $13,
          igst = $14,
          total = $15,
          status = $16,
          extraction_confidence = $17::jsonb,
          extraction_source = $18,
          extraction_method = $19,
          raw_extracted_text = $20,
          original_extracted_data = $21::jsonb
      WHERE id = $22
      RETURNING *;
      `,
      [
        extraction.fields.invoice_number,
        extraction.fields.normalized_invoice_number,
        extraction.fields.irn,
        matchedSupplierId,
        extraction.fields.supplier_name,
        extraction.fields.supplier_gstin,
        matchedPoId,
        extraction.fields.po_reference,
        extraction.fields.bank_identifier,
        extraction.fields.invoice_date,
        extraction.fields.subtotal,
        extraction.fields.cgst ?? 0,
        extraction.fields.sgst ?? 0,
        extraction.fields.igst ?? 0,
        extraction.fields.total,
        extraction.status,
        JSON.stringify(extraction.extractionConfidence),
        extraction.extractionSource,
        extraction.extractionMethod,
        extraction.rawText,
        JSON.stringify(originalSnapshot),
        invoiceId,
      ]
    );

    const insertedLines: InvoiceLineRecord[] = [];
    for (let i = 0; i < extraction.lineItems.length; i++) {
      const li = extraction.lineItems[i];
      const lineRes = await updateClient.query<InvoiceLineRecord>(
        `
        INSERT INTO invoice_lines (
          invoice_id, line_number, description, quantity, unit, unit_price, line_total, is_sample_data
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
        RETURNING *;
        `,
        [invoiceId, i + 1, li.description, li.quantity, li.unit, li.unitPrice, li.lineTotal]
      );
      insertedLines.push(lineRes.rows[0]);
    }

    await writeAuditLog(
      params.uploadedBy,
      'INVOICE_EXTRACTED',
      'invoices',
      invoiceId,
      {
        status: extraction.status,
        extractionSource: extraction.extractionSource,
        extractionMethod: extraction.extractionMethod,
        ocrConfidence: extraction.ocrConfidence,
        invoiceNumber: extraction.fields.invoice_number,
        missingFields: extraction.extractionConfidence.missingFields,
        lowConfidenceFields: extraction.extractionConfidence.lowConfidenceFields,
      },
      updateClient
    );

    await updateClient.query('COMMIT');
    return {
      invoice: updatedRes.rows[0],
      lines: insertedLines,
      extraction,
    };
  } catch (err) {
    await updateClient.query('ROLLBACK');
    throw err;
  } finally {
    updateClient.release();
  }
}

export async function listInvoices(): Promise<InvoiceRecord[]> {
  const [res, duplicateFlags] = await Promise.all([
    query<InvoiceRecord>(
      `
      SELECT
        i.*,
        COALESCE(i.supplier_name_extracted, s.name) AS supplier_name,
        po.po_number,
        v.name AS verified_by_name,
        mr.status AS match_status,
        mr.reasons AS match_reasons
      FROM invoices i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN purchase_orders po ON po.id = i.po_id
      LEFT JOIN users v ON v.id = i.verified_by
      LEFT JOIN LATERAL (
        SELECT m.status, m.reasons
        FROM match_results m
        WHERE m.invoice_id = i.id
        ORDER BY m.evaluated_at DESC, m.id DESC
        LIMIT 1
      ) mr ON TRUE
      ORDER BY i.is_historical ASC, i.id DESC;
      `
    ),
    getDuplicateFlagsByInvoice(),
  ]);

  return res.rows.map((row) => {
    const dup = duplicateFlags.get(row.id);
    return {
      ...row,
      possible_duplicate: dup?.isPossibleDuplicate ?? false,
      duplicate_score: dup?.highestScore ?? 0,
      duplicate_reasons: dup?.reasons ?? [],
    };
  });
}

export async function getInvoiceSummaryMetrics(): Promise<{
  totalInvoices: number;
  matchedCount: number;
  mismatchedCount: number;
  holdCount: number;
  onHoldCount: number;
  possibleDuplicatesCount: number;
}> {
  const [countsRes, duplicateFlags] = await Promise.all([
    query<{
      total_invoices: string;
      matched_count: string;
      mismatched_count: string;
      hold_count: string;
      on_hold_count: string;
    }>(
      `
      SELECT
        COUNT(*)::text AS total_invoices,
        COUNT(*) FILTER (WHERE COALESCE(mr.status, i.status) = 'MATCHED')::text AS matched_count,
        COUNT(*) FILTER (WHERE mr.status = 'MISMATCH')::text AS mismatched_count,
        COUNT(*) FILTER (WHERE mr.status = 'HOLD')::text AS hold_count,
        COUNT(*) FILTER (WHERE i.status = 'ON_HOLD')::text AS on_hold_count
      FROM invoices i
      LEFT JOIN LATERAL (
        SELECT m.status
        FROM match_results m
        WHERE m.invoice_id = i.id
        ORDER BY m.evaluated_at DESC, m.id DESC
        LIMIT 1
      ) mr ON TRUE;
      `
    ),
    getDuplicateFlagsByInvoice(),
  ]);

  const row = countsRes.rows[0];
  let possibleDuplicatesCount = 0;
  for (const val of duplicateFlags.values()) {
    if (val.isPossibleDuplicate) possibleDuplicatesCount++;
  }

  return {
    totalInvoices: Number(row?.total_invoices || 0),
    matchedCount: Number(row?.matched_count || 0),
    mismatchedCount: Number(row?.mismatched_count || 0),
    holdCount: Number(row?.hold_count || 0),
    onHoldCount: Number(row?.on_hold_count || 0),
    possibleDuplicatesCount,
  };
}

export async function getInvoiceById(id: number): Promise<{
  invoice: InvoiceRecord;
  lines: InvoiceLineRecord[];
}> {
  const invRes = await query<InvoiceRecord>(
    `
    SELECT
      i.*,
      COALESCE(i.supplier_name_extracted, s.name) AS supplier_name,
      po.po_number,
      v.name AS verified_by_name,
      l1.name AS level1_approved_by_name,
      pa.name AS payment_approved_by_name
    FROM invoices i
    LEFT JOIN suppliers s ON s.id = i.supplier_id
    LEFT JOIN purchase_orders po ON po.id = i.po_id
    LEFT JOIN users v ON v.id = i.verified_by
    LEFT JOIN users l1 ON l1.id = i.level1_approved_by
    LEFT JOIN users pa ON pa.id = i.payment_approved_by
    WHERE i.id = $1
    LIMIT 1;
    `,
    [id]
  );

  if (invRes.rowCount === 0) {
    throw new HttpError(404, `Invoice #${id} not found.`);
  }

  const linesRes = await query<InvoiceLineRecord>(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number ASC',
    [id]
  );

  return {
    invoice: invRes.rows[0],
    lines: linesRes.rows,
  };
}

export function resolveStoredInvoiceFile(filePath: string | null): string | null {
  if (!filePath) return null;
  const projectRoot = path.resolve(env.UPLOAD_DIR, '..');
  const candidate = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectRoot, filePath);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const fallback = path.resolve(process.cwd(), filePath);
  return fs.existsSync(fallback) ? fallback : null;
}

export interface VerifyInvoicePayload {
  supplierName?: string | null;
  supplierGstin?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  poReference?: string | null;
  irn?: string | null;
  bankIdentifier?: string | null;
  subtotal?: number | null;
  cgst?: number | null;
  sgst?: number | null;
  igst?: number | null;
  total?: number | null;
  lineItems?: Array<{
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    lineTotal: number;
  }>;
}

export async function verifyInvoice(
  invoiceId: number,
  actorId: number,
  payload: VerifyInvoicePayload
): Promise<{
  invoice: InvoiceRecord;
  lines: InvoiceLineRecord[];
  diff: Record<string, { before: unknown; after: unknown }>;
  verifiedStatus: 'VERIFIED';
  matchResult: StoredMatchResultRecord;
}> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingRes = await client.query<InvoiceRecord>(
      'SELECT * FROM invoices WHERE id = $1 FOR UPDATE',
      [invoiceId]
    );
    if (existingRes.rowCount === 0) {
      throw new HttpError(404, `Invoice #${invoiceId} not found.`);
    }
    const existing = existingRes.rows[0];

    const existingLinesRes = await client.query<InvoiceLineRecord>(
      'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number ASC',
      [invoiceId]
    );

    const originalExtracted = existing.original_extracted_data ?? {
      supplier_name: existing.supplier_name_extracted,
      supplier_gstin: existing.supplier_gstin_extracted,
      invoice_number: existing.invoice_number,
      normalized_invoice_number: existing.normalized_invoice_number,
      invoice_date: existing.invoice_date,
      po_reference: existing.po_reference_extracted,
      irn: existing.irn,
      bank_identifier: existing.bank_identifier_extracted,
      subtotal: existing.subtotal !== null ? Number(existing.subtotal) : null,
      cgst: existing.cgst !== null ? Number(existing.cgst) : 0,
      sgst: existing.sgst !== null ? Number(existing.sgst) : 0,
      igst: existing.igst !== null ? Number(existing.igst) : 0,
      total: existing.total !== null ? Number(existing.total) : null,
      lineItems: existingLinesRes.rows,
    };

    const nextSupplierName = payload.supplierName !== undefined ? payload.supplierName : existing.supplier_name_extracted;
    const nextSupplierGstin = payload.supplierGstin !== undefined
      ? (payload.supplierGstin ? payload.supplierGstin.trim().toUpperCase() : null)
      : existing.supplier_gstin_extracted;
    const nextInvoiceNumber = payload.invoiceNumber !== undefined ? payload.invoiceNumber : existing.invoice_number;
    const nextNormalizedNumber = normalizeInvoiceNumber(nextInvoiceNumber);
    const nextInvoiceDate = payload.invoiceDate !== undefined ? payload.invoiceDate : existing.invoice_date;

    if (nextInvoiceDate && !isValidIsoDate(String(nextInvoiceDate).slice(0, 10))) {
      throw new HttpError(400, 'invoiceDate must be a valid YYYY-MM-DD date.');
    }

    const nextPoRef = payload.poReference !== undefined ? payload.poReference : existing.po_reference_extracted;
    const nextIrn = payload.irn !== undefined ? payload.irn : existing.irn;
    const nextBankId = payload.bankIdentifier !== undefined ? payload.bankIdentifier : existing.bank_identifier_extracted;
    const nextSubtotal = payload.subtotal !== undefined ? payload.subtotal : (existing.subtotal !== null ? Number(existing.subtotal) : null);
    const nextCgst = payload.cgst !== undefined ? (payload.cgst ?? 0) : Number(existing.cgst || 0);
    const nextSgst = payload.sgst !== undefined ? (payload.sgst ?? 0) : Number(existing.sgst || 0);
    const nextIgst = payload.igst !== undefined ? (payload.igst ?? 0) : Number(existing.igst || 0);
    const nextTotal = payload.total !== undefined ? payload.total : (existing.total !== null ? Number(existing.total) : null);

    // Build diff against current pre-verification state
    const beforeSnapshot: Record<string, unknown> = {
      supplier_name: existing.supplier_name_extracted,
      supplier_gstin: existing.supplier_gstin_extracted,
      invoice_number: existing.invoice_number,
      invoice_date: existing.invoice_date ? String(existing.invoice_date).slice(0, 10) : null,
      po_reference: existing.po_reference_extracted,
      irn: existing.irn,
      bank_identifier: existing.bank_identifier_extracted,
      subtotal: existing.subtotal !== null ? Number(existing.subtotal) : null,
      cgst: Number(existing.cgst || 0),
      sgst: Number(existing.sgst || 0),
      igst: Number(existing.igst || 0),
      total: existing.total !== null ? Number(existing.total) : null,
    };

    const afterSnapshot: Record<string, unknown> = {
      supplier_name: nextSupplierName,
      supplier_gstin: nextSupplierGstin,
      invoice_number: nextInvoiceNumber,
      invoice_date: nextInvoiceDate ? String(nextInvoiceDate).slice(0, 10) : null,
      po_reference: nextPoRef,
      irn: nextIrn,
      bank_identifier: nextBankId,
      subtotal: nextSubtotal,
      cgst: nextCgst,
      sgst: nextSgst,
      igst: nextIgst,
      total: nextTotal,
    };

    const diff: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of Object.keys(afterSnapshot)) {
      if (beforeSnapshot[key] !== afterSnapshot[key]) {
        diff[key] = { before: beforeSnapshot[key], after: afterSnapshot[key] };
      }
    }

    let matchedSupplierId = existing.supplier_id;
    if (nextSupplierGstin) {
      const supRes = await client.query<{ id: number }>(
        'SELECT id FROM suppliers WHERE UPPER(gstin) = $1 LIMIT 1',
        [nextSupplierGstin.toUpperCase()]
      );
      if (supRes.rows[0]) {
        matchedSupplierId = supRes.rows[0].id;
      }
    }

    let matchedPoId = existing.po_id;
    if (nextPoRef) {
      const poRes = await client.query<{ id: number }>(
        'SELECT id FROM purchase_orders WHERE UPPER(po_number) = $1 LIMIT 1',
        [nextPoRef.toUpperCase()]
      );
      if (poRes.rows[0]) {
        matchedPoId = poRes.rows[0].id;
      }
    }

    const verifiedPayload = {
      ...afterSnapshot,
      normalized_invoice_number: nextNormalizedNumber,
      lineItems: payload.lineItems ?? existingLinesRes.rows,
    };

    const updatedRes = await client.query<InvoiceRecord>(
      `
      UPDATE invoices
      SET supplier_id = $1,
          supplier_name_extracted = $2,
          supplier_gstin_extracted = $3,
          invoice_number = $4,
          normalized_invoice_number = $5,
          invoice_date = $6::date,
          po_id = $7,
          po_reference_extracted = $8,
          irn = $9,
          bank_identifier_extracted = $10,
          subtotal = $11,
          cgst = $12,
          sgst = $13,
          igst = $14,
          total = $15,
          original_extracted_data = COALESCE(original_extracted_data, $16::jsonb),
          verified_data = $17::jsonb,
          verified_by = $18,
          verified_at = NOW(),
          status = 'VERIFIED'
      WHERE id = $19
      RETURNING *;
      `,
      [
        matchedSupplierId,
        nextSupplierName,
        nextSupplierGstin,
        nextInvoiceNumber,
        nextNormalizedNumber,
        nextInvoiceDate ? String(nextInvoiceDate).slice(0, 10) : null,
        matchedPoId,
        nextPoRef,
        nextIrn,
        nextBankId,
        nextSubtotal,
        nextCgst,
        nextSgst,
        nextIgst,
        nextTotal,
        JSON.stringify(originalExtracted),
        JSON.stringify(verifiedPayload),
        actorId,
        invoiceId,
      ]
    );

    let updatedLines = existingLinesRes.rows;
    if (Array.isArray(payload.lineItems)) {
      await client.query('DELETE FROM invoice_lines WHERE invoice_id = $1', [invoiceId]);
      updatedLines = [];
      for (let i = 0; i < payload.lineItems.length; i++) {
        const li = payload.lineItems[i];
        const lineRes = await client.query<InvoiceLineRecord>(
          `
          INSERT INTO invoice_lines (
            invoice_id, line_number, description, quantity, unit, unit_price, line_total, is_sample_data
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
          RETURNING *;
          `,
          [
            invoiceId,
            i + 1,
            li.description,
            li.quantity,
            li.unit || 'kg',
            li.unitPrice,
            li.lineTotal,
          ]
        );
        updatedLines.push(lineRes.rows[0]);
      }
    }

    await writeAuditLog(
      actorId,
      'INVOICE_VERIFIED',
      'invoices',
      invoiceId,
      {
        previousStatus: existing.status,
        newStatus: 'VERIFIED',
        diff,
      },
      client
    );

    await client.query('COMMIT');

    // Auto-run full matching, duplicate, GST, PO change, overbilling, risk & investigation pipeline
    const evaluated = await syncAndEvaluateInvoice(invoiceId, actorId);
    const refreshed = await getInvoiceById(invoiceId);

    return {
      invoice: refreshed.invoice,
      lines: refreshed.lines,
      diff,
      verifiedStatus: 'VERIFIED',
      matchResult: evaluated.pipeline.matchResult,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
