import { query } from '../db/pool.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { normalizeInvoiceNumber } from '../utils/invoiceNormalizer.ts';

export interface DuplicateCandidateInput {
  id: number;
  invoiceNumber: string | null;
  normalizedInvoiceNumber: string | null;
  irn: string | null;
  supplierId: number | null;
  supplierGstin: string | null;
  supplierName: string | null;
  invoiceDate: string | null;
  subtotal: number | null;
  total: number | null;
  status: string;
  isHistorical: boolean;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
  }>;
}

export interface DuplicateMatchItem {
  candidateInvoiceId: number;
  candidateInvoiceNumber: string | null;
  candidateNormalizedNumber: string | null;
  candidateSupplierName: string | null;
  candidateInvoiceDate: string | null;
  candidateTotal: number | null;
  candidateStatus: string;
  isHistorical: boolean;
  similarityScore: number;
  isPossibleDuplicate: boolean;
  reasons: string[];
}

export interface DuplicateDetectionResult {
  invoiceId: number;
  invoiceNumber: string | null;
  normalizedInvoiceNumber: string | null;
  threshold: number;
  hasPossibleDuplicates: boolean;
  highestScore: number;
  possibleDuplicates: DuplicateMatchItem[];
}

function normalizeSupplierKey(gstin: string | null, name: string | null): string {
  if (gstin && gstin.trim()) return `gstin:${gstin.trim().toUpperCase()}`;
  if (name && name.trim()) {
    return `name:${name
      .toLowerCase()
      .replace(/\(sample\)/gi, '')
      .replace(/[^a-z0-9]/g, '')}`;
  }
  return '';
}

function isSameSupplier(a: DuplicateCandidateInput, b: DuplicateCandidateInput): boolean {
  if (a.supplierId !== null && b.supplierId !== null && a.supplierId === b.supplierId) {
    return true;
  }
  if (
    a.supplierGstin &&
    b.supplierGstin &&
    a.supplierGstin.trim().toUpperCase() === b.supplierGstin.trim().toUpperCase()
  ) {
    return true;
  }
  const keyA = normalizeSupplierKey(a.supplierGstin, a.supplierName);
  const keyB = normalizeSupplierKey(b.supplierGstin, b.supplierName);
  return Boolean(keyA && keyB && keyA === keyB);
}

function daysBetween(dateA: string | null, dateB: string | null): number | null {
  if (!dateA || !dateB) return null;
  const tA = Date.parse(dateA.slice(0, 10));
  const tB = Date.parse(dateB.slice(0, 10));
  if (Number.isNaN(tA) || Number.isNaN(tB)) return null;
  return Math.round(Math.abs(tA - tB) / (1000 * 60 * 60 * 24));
}

function computeLineItemSimilarity(
  linesA: DuplicateCandidateInput['lineItems'],
  linesB: DuplicateCandidateInput['lineItems']
): number {
  if (linesA.length === 0 || linesB.length === 0) return 0;

  let matchedCount = 0;
  for (const la of linesA) {
    const descA = la.description.toLowerCase().replace(/\(sample\)/gi, '').trim();
    const matchFound = linesB.some((lb) => {
      const descB = lb.description.toLowerCase().replace(/\(sample\)/gi, '').trim();
      const descMatch =
        descA === descB || (descA.length > 3 && (descA.includes(descB) || descB.includes(descA)));
      const qtyClose =
        la.quantity > 0 && lb.quantity > 0
          ? Math.abs(la.quantity - lb.quantity) / Math.max(la.quantity, lb.quantity) <= 0.02
          : la.quantity === lb.quantity;
      const priceClose =
        la.unitPrice > 0 && lb.unitPrice > 0
          ? Math.abs(la.unitPrice - lb.unitPrice) / Math.max(la.unitPrice, lb.unitPrice) <= 0.02
          : la.unitPrice === lb.unitPrice;
      return descMatch && qtyClose && priceClose;
    });
    if (matchFound) matchedCount++;
  }

  return matchedCount / Math.max(linesA.length, linesB.length);
}

/**
 * Pure duplicate similarity scorer (0 to 1) comparing normalized invoice number,
 * supplier, invoice date proximity, amount, line items, and e-invoice IRN.
 * Never auto-rejects; flags POSSIBLE DUPLICATE when similarityScore >= threshold.
 */
export function scoreDuplicateCandidate(
  target: DuplicateCandidateInput,
  candidate: DuplicateCandidateInput,
  threshold = 0.65
): DuplicateMatchItem {
  let score = 0;
  const reasons: string[] = [];

  const normA = target.normalizedInvoiceNumber || normalizeInvoiceNumber(target.invoiceNumber);
  const normB = candidate.normalizedInvoiceNumber || normalizeInvoiceNumber(candidate.invoiceNumber);

  const sameNumber = Boolean(normA && normB && normA === normB);
  const sameSupplier = isSameSupplier(target, candidate);
  const sameIrn = Boolean(
    target.irn &&
      candidate.irn &&
      target.irn.trim().length > 0 &&
      target.irn.trim().toUpperCase() === candidate.irn.trim().toUpperCase()
  );

  if (sameNumber) {
    score += 0.35;
    reasons.push(
      `Same normalized invoice number (${normA}: "${target.invoiceNumber}" vs "${candidate.invoiceNumber}")`
    );
  }

  if (sameSupplier) {
    score += 0.35;
    reasons.push(
      `Same supplier (${target.supplierName || target.supplierGstin || `Supplier #${target.supplierId}`})`
    );
  }

  if (sameIrn) {
    score += 0.4;
    reasons.push(`Matching e-Invoice IRN (${target.irn})`);
  }

  // Amount check
  const amtA = target.total ?? target.subtotal;
  const amtB = candidate.total ?? candidate.subtotal;
  if (amtA !== null && amtB !== null && amtA > 0 && amtB > 0) {
    const diffRatio = Math.abs(amtA - amtB) / Math.max(amtA, amtB);
    if (diffRatio <= 0.01 || Math.abs(amtA - amtB) <= 1) {
      score += 0.15;
      reasons.push(`Same invoice amount (Rs ${amtA.toFixed(2)})`);
    } else if (diffRatio <= 0.05) {
      score += 0.05;
      reasons.push(`Similar invoice amount (Rs ${amtA.toFixed(2)} vs Rs ${amtB.toFixed(2)})`);
    }
  }

  // Date proximity check
  const dayDiff = daysBetween(target.invoiceDate, candidate.invoiceDate);
  if (dayDiff !== null) {
    if (dayDiff === 0) {
      score += 0.1;
      reasons.push(`Same invoice date (${target.invoiceDate?.slice(0, 10)})`);
    } else if (dayDiff <= 7) {
      score += 0.07;
      reasons.push(`Near invoice date (${dayDiff} day${dayDiff === 1 ? '' : 's'} apart)`);
    }
  }

  // Line items check
  const lineSim = computeLineItemSimilarity(target.lineItems, candidate.lineItems);
  if (lineSim >= 0.7) {
    score += 0.1;
    reasons.push(`Similar line items (${Math.round(lineSim * 100)}% overlap)`);
  } else if (lineSim >= 0.4) {
    score += 0.05;
    reasons.push(`Partially overlapping line items (${Math.round(lineSim * 100)}%)`);
  }

  const clampedScore = Number(Math.min(1, Math.max(0, score)).toFixed(2));
  const isPossibleDuplicate = clampedScore >= threshold;

  return {
    candidateInvoiceId: candidate.id,
    candidateInvoiceNumber: candidate.invoiceNumber,
    candidateNormalizedNumber: normB,
    candidateSupplierName: candidate.supplierName,
    candidateInvoiceDate: candidate.invoiceDate ? candidate.invoiceDate.slice(0, 10) : null,
    candidateTotal: candidate.total,
    candidateStatus: candidate.status,
    isHistorical: candidate.isHistorical,
    similarityScore: clampedScore,
    isPossibleDuplicate,
    reasons,
  };
}

interface DbInvoiceWithLinesRow {
  id: number;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  irn: string | null;
  supplier_id: number | null;
  supplier_gstin: string | null;
  supplier_name: string | null;
  invoice_date: Date | string | null;
  subtotal: string | null;
  total: string | null;
  status: string;
  is_historical: boolean;
}

async function getDuplicateThreshold(): Promise<number> {
  const res = await query<{ threshold: string }>(
    `
    SELECT threshold
    FROM risk_rules_config
    WHERE rule_code = 'DUPLICATE_INVOICE' AND is_active = TRUE
    LIMIT 1;
    `
  );
  if (res.rows[0]) {
    const val = Number(res.rows[0].threshold);
    if (Number.isFinite(val) && val > 0 && val <= 1) {
      return val;
    }
  }
  return 0.65;
}

async function loadAllInvoiceCandidates(): Promise<DuplicateCandidateInput[]> {
  const invRes = await query<DbInvoiceWithLinesRow>(
    `
    SELECT
      i.id,
      i.invoice_number,
      i.normalized_invoice_number,
      i.irn,
      i.supplier_id,
      COALESCE(s.gstin, i.supplier_gstin_extracted) AS supplier_gstin,
      COALESCE(s.name, i.supplier_name_extracted) AS supplier_name,
      i.invoice_date,
      i.subtotal,
      i.total,
      i.status,
      i.is_historical
    FROM invoices i
    LEFT JOIN suppliers s ON s.id = i.supplier_id
    ORDER BY i.id ASC;
    `
  );

  const linesRes = await query<{
    invoice_id: number;
    description: string;
    quantity: string;
    unit_price: string;
  }>(
    'SELECT invoice_id, description, quantity, unit_price FROM invoice_lines ORDER BY invoice_id ASC, line_number ASC'
  );

  const linesByInv = new Map<number, DuplicateCandidateInput['lineItems']>();
  for (const row of linesRes.rows) {
    const list = linesByInv.get(row.invoice_id) || [];
    list.push({
      description: row.description,
      quantity: Number(row.quantity),
      unitPrice: Number(row.unit_price),
    });
    linesByInv.set(row.invoice_id, list);
  }

  return invRes.rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoice_number,
    normalizedInvoiceNumber: r.normalized_invoice_number,
    irn: r.irn,
    supplierId: r.supplier_id,
    supplierGstin: r.supplier_gstin,
    supplierName: r.supplier_name,
    invoiceDate:
      r.invoice_date instanceof Date
        ? r.invoice_date.toISOString().slice(0, 10)
        : r.invoice_date
        ? String(r.invoice_date).slice(0, 10)
        : null,
    subtotal: r.subtotal !== null ? Number(r.subtotal) : null,
    total: r.total !== null ? Number(r.total) : null,
    status: r.status,
    isHistorical: r.is_historical,
    lineItems: linesByInv.get(r.id) || [],
  }));
}

export async function detectDuplicatesForInvoice(
  invoiceId: number
): Promise<DuplicateDetectionResult> {
  const [threshold, allCandidates] = await Promise.all([
    getDuplicateThreshold(),
    loadAllInvoiceCandidates(),
  ]);

  const target = allCandidates.find((c) => c.id === invoiceId);
  if (!target) {
    throw new HttpError(404, `Invoice #${invoiceId} not found.`);
  }

  const scored = allCandidates
    .filter((c) => c.id !== invoiceId)
    .map((candidate) => scoreDuplicateCandidate(target, candidate, threshold))
    .filter((m) => m.isPossibleDuplicate)
    .sort((a, b) => b.similarityScore - a.similarityScore);

  const highestScore = scored.length > 0 ? scored[0].similarityScore : 0;

  return {
    invoiceId: target.id,
    invoiceNumber: target.invoiceNumber,
    normalizedInvoiceNumber:
      target.normalizedInvoiceNumber || normalizeInvoiceNumber(target.invoiceNumber),
    threshold,
    hasPossibleDuplicates: scored.length > 0,
    highestScore,
    possibleDuplicates: scored,
  };
}

export async function getDuplicateFlagsByInvoice(): Promise<
  Map<number, { isPossibleDuplicate: boolean; highestScore: number; reasons: string[] }>
> {
  const [threshold, allCandidates] = await Promise.all([
    getDuplicateThreshold(),
    loadAllInvoiceCandidates(),
  ]);

  const flagMap = new Map<
    number,
    { isPossibleDuplicate: boolean; highestScore: number; reasons: string[] }
  >();

  for (const target of allCandidates) {
    let bestScore = 0;
    let bestReasons: string[] = [];

    for (const candidate of allCandidates) {
      if (candidate.id === target.id) continue;
      const scored = scoreDuplicateCandidate(target, candidate, threshold);
      if (scored.isPossibleDuplicate && scored.similarityScore > bestScore) {
        bestScore = scored.similarityScore;
        bestReasons = scored.reasons;
      }
    }

    flagMap.set(target.id, {
      isPossibleDuplicate: bestScore >= threshold,
      highestScore: bestScore,
      reasons: bestReasons,
    });
  }

  return flagMap;
}
