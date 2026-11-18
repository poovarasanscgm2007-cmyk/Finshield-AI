import { PoolClient } from 'pg';
import { getPool, query } from '../db/pool.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { writeAuditLog } from './auditService.ts';

export type MatchStatus = 'MATCHED' | 'MISMATCH' | 'HOLD';

export interface ThreeWayPoLineInput {
  id: number;
  description: string;
  hsnSac: string | null;
  orderedQuantity: number;
  unit: string;
  approvedUnitPrice: number;
  currentUnitPrice: number;
  hasUnapprovedPriceChange: boolean;
  gstRate: number;
}

export interface ThreeWayGrnInput {
  grnId: number;
  grnNumber: string;
  receivedAt: string;
  poLineId: number | null;
  description: string;
  quantityReceived: number;
  unit: string;
}

export interface ThreeWayInvoiceLineInput {
  id: number;
  description: string;
  hsnSac: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  taxRate: number;
  lineTotal: number;
}

export interface ThreeWayComparisonCell {
  field: 'product' | 'quantity' | 'unit_price' | 'tax' | 'total';
  label: string;
  poValue: string;
  grnValue: string;
  invoiceValue: string;
  mismatch: boolean;
  reason: string | null;
}

export interface ThreeWayComparedValues {
  poNumber: string | null;
  poStatus: string | null;
  poProduct: string | null;
  poOrderedQty: number | null;
  poApprovedUnitPrice: number | null;
  poCurrentUnitPrice: number | null;
  poUnapprovedPriceChange: boolean;
  poGstRate: number | null;
  poExpectedTotal: number | null;
  grnCount: number;
  grns: Array<{
    grnNumber: string;
    receivedAt: string;
    quantityReceived: number;
    unit: string;
  }>;
  grnReceivedQty: number;
  invoiceNumber: string | null;
  invoiceProduct: string | null;
  invoiceQty: number | null;
  invoiceUnitPrice: number | null;
  invoiceSubtotal: number | null;
  invoiceTaxAmount: number;
  expectedTaxAmount: number | null;
  invoiceTotal: number | null;
  mismatchedFields: string[];
  cells: ThreeWayComparisonCell[];
}

export interface EvaluatedMatchOutcome {
  status: MatchStatus;
  reasons: string[];
  qtyTolerancePercent: number;
  priceTolerancePercent: number;
  comparedValues: ThreeWayComparedValues;
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : Number(n.toFixed(2)).toString();
}

function normalizeProductText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/\(sample\)/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function productsMatch(
  invDesc: string | null | undefined,
  poDesc: string | null | undefined,
  invHsn?: string | null,
  poHsn?: string | null
): boolean {
  if (invHsn && poHsn && invHsn.trim() === poHsn.trim()) {
    return true;
  }
  const a = normalizeProductText(invDesc);
  const b = normalizeProductText(poDesc);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) {
    return true;
  }
  const tokensA = new Set(a.split(' ').filter((t) => t.length >= 3));
  const tokensB = new Set(b.split(' ').filter((t) => t.length >= 3));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
  }
  return overlap / Math.min(tokensA.size, tokensB.size) >= 0.5;
}

/**
 * Pure deterministic 3-way matching evaluator (PO vs summed GRNs vs Invoice).
 */
export function evaluateThreeWayMatch(input: {
  poNumber: string | null;
  poStatus: string | null;
  poLines: ThreeWayPoLineInput[];
  grns: ThreeWayGrnInput[];
  invoiceNumber: string | null;
  invoiceSubtotal: number | null;
  invoiceCgst: number;
  invoiceSgst: number;
  invoiceIgst: number;
  invoiceTotal: number | null;
  invoiceLines: ThreeWayInvoiceLineInput[];
  qtyTolerancePercent?: number;
  priceTolerancePercent?: number;
}): EvaluatedMatchOutcome {
  const qtyTol = Number.isFinite(input.qtyTolerancePercent)
    ? Number(input.qtyTolerancePercent)
    : 2.0;
  const priceTol = Number.isFinite(input.priceTolerancePercent)
    ? Number(input.priceTolerancePercent)
    : 2.0;

  const reasons: string[] = [];
  const mismatchedFields = new Set<string>();
  let hasMismatch = false;
  let hasHold = false;

  const totalGrnQty = Number(
    input.grns.reduce((sum, g) => sum + Number(g.quantityReceived || 0), 0).toFixed(3)
  );
  const uniqueGrnsMap = new Map<
    string,
    { grnNumber: string; receivedAt: string; quantityReceived: number; unit: string }
  >();
  for (const g of input.grns) {
    const existing = uniqueGrnsMap.get(g.grnNumber);
    if (existing) {
      existing.quantityReceived = Number(
        (existing.quantityReceived + Number(g.quantityReceived || 0)).toFixed(3)
      );
    } else {
      uniqueGrnsMap.set(g.grnNumber, {
        grnNumber: g.grnNumber,
        receivedAt: g.receivedAt,
        quantityReceived: Number(g.quantityReceived || 0),
        unit: g.unit || 'kg',
      });
    }
  }
  const grnSummaries = Array.from(uniqueGrnsMap.values());

  const invTaxAmount = Number(
    ((input.invoiceCgst || 0) + (input.invoiceSgst || 0) + (input.invoiceIgst || 0)).toFixed(2)
  );
  const invQtySum = Number(
    input.invoiceLines.reduce((sum, l) => sum + Number(l.quantity || 0), 0).toFixed(3)
  );
  const primaryInvLine = input.invoiceLines[0] ?? null;
  const primaryPoLine = input.poLines[0] ?? null;

  // Missing PO -> HOLD
  if (!input.poNumber || !primaryPoLine) {
    hasHold = true;
    reasons.push('No Purchase Order linked to invoice for 3-way matching');
    mismatchedFields.add('product');
    mismatchedFields.add('quantity');
    mismatchedFields.add('unit_price');

    const cells: ThreeWayComparisonCell[] = [
      {
        field: 'product',
        label: 'Product / Item',
        poValue: 'No PO Linked',
        grnValue: totalGrnQty > 0 ? `${fmtNum(totalGrnQty)}` : 'No GRN',
        invoiceValue: primaryInvLine?.description || 'Missing',
        mismatch: true,
        reason: 'No Purchase Order linked to invoice for 3-way matching',
      },
      {
        field: 'quantity',
        label: 'Quantity',
        poValue: '—',
        grnValue: '—',
        invoiceValue: primaryInvLine ? `${fmtNum(invQtySum)} ${primaryInvLine.unit}` : '—',
        mismatch: true,
        reason: 'Cannot verify quantity without Purchase Order',
      },
      {
        field: 'unit_price',
        label: 'Unit Price',
        poValue: '—',
        grnValue: 'N/A',
        invoiceValue: primaryInvLine ? `Rs ${fmtNum(primaryInvLine.unitPrice)}` : '—',
        mismatch: true,
        reason: 'Cannot verify unit price without Purchase Order',
      },
      {
        field: 'tax',
        label: 'GST / Tax Amount',
        poValue: '—',
        grnValue: 'N/A',
        invoiceValue: `Rs ${fmtNum(invTaxAmount)}`,
        mismatch: false,
        reason: null,
      },
      {
        field: 'total',
        label: 'Invoice Total',
        poValue: '—',
        grnValue: 'N/A',
        invoiceValue: input.invoiceTotal !== null ? `Rs ${fmtNum(input.invoiceTotal)}` : '—',
        mismatch: false,
        reason: null,
      },
    ];

    return {
      status: 'HOLD',
      reasons,
      qtyTolerancePercent: qtyTol,
      priceTolerancePercent: priceTol,
      comparedValues: {
        poNumber: null,
        poStatus: null,
        poProduct: null,
        poOrderedQty: null,
        poApprovedUnitPrice: null,
        poCurrentUnitPrice: null,
        poUnapprovedPriceChange: false,
        poGstRate: null,
        poExpectedTotal: null,
        grnCount: grnSummaries.length,
        grns: grnSummaries,
        grnReceivedQty: totalGrnQty,
        invoiceNumber: input.invoiceNumber,
        invoiceProduct: primaryInvLine?.description ?? null,
        invoiceQty: primaryInvLine ? invQtySum : null,
        invoiceUnitPrice: primaryInvLine?.unitPrice ?? null,
        invoiceSubtotal: input.invoiceSubtotal,
        invoiceTaxAmount: invTaxAmount,
        expectedTaxAmount: null,
        invoiceTotal: input.invoiceTotal,
        mismatchedFields: Array.from(mismatchedFields),
        cells,
      },
    };
  }

  const poOrderedQty = Number(
    input.poLines.reduce((sum, l) => sum + Number(l.orderedQuantity || 0), 0).toFixed(3)
  );
  const poApprovedPrice = Number(primaryPoLine.approvedUnitPrice);
  const poGstRate = Number(primaryPoLine.gstRate || 18);
  const unitLabel = primaryPoLine.unit || primaryInvLine?.unit || 'kg';

  // 1. Product check
  let productMismatchReason: string | null = null;
  if (!primaryInvLine) {
    hasMismatch = true;
    mismatchedFields.add('product');
    productMismatchReason = 'Invoice has no extracted line items to match PO product';
    reasons.push(productMismatchReason);
  } else {
    const anyMatches = input.invoiceLines.some((invLine) =>
      input.poLines.some((poLine) =>
        productsMatch(invLine.description, poLine.description, invLine.hsnSac, poLine.hsnSac)
      )
    );
    if (!anyMatches) {
      hasMismatch = true;
      mismatchedFields.add('product');
      productMismatchReason = `Invoice product "${primaryInvLine.description}" does not match PO item "${primaryPoLine.description}"`;
      reasons.push(productMismatchReason);
    }
  }

  // 2. Quantity check (Invoice vs summed GRNs and vs PO ordered qty)
  let qtyMismatchReason: string | null = null;
  if (input.grns.length === 0 || totalGrnQty <= 0) {
    if (invQtySum > 0) {
      hasMismatch = true;
      mismatchedFields.add('quantity');
      qtyMismatchReason = `Invoice qty ${fmtNum(invQtySum)} exceeds received qty 0 by ${fmtNum(invQtySum)}`;
      reasons.push(qtyMismatchReason);
    } else {
      hasHold = true;
      mismatchedFields.add('quantity');
      qtyMismatchReason = `Pending delivery: ${fmtNum(poOrderedQty)} not yet received`;
      reasons.push(qtyMismatchReason);
    }
  } else {
    const maxAllowedByGrn = totalGrnQty * (1 + qtyTol / 100);
    const maxAllowedByPo = poOrderedQty * (1 + qtyTol / 100);

    if (invQtySum > maxAllowedByGrn) {
      hasMismatch = true;
      mismatchedFields.add('quantity');
      const excess = Number((invQtySum - totalGrnQty).toFixed(3));
      qtyMismatchReason = `Invoice qty ${fmtNum(invQtySum)} exceeds received qty ${fmtNum(totalGrnQty)} by ${fmtNum(excess)}`;
      reasons.push(qtyMismatchReason);
    }

    if (invQtySum > maxAllowedByPo) {
      hasMismatch = true;
      mismatchedFields.add('quantity');
      const poExcess = Number((invQtySum - poOrderedQty).toFixed(3));
      const r = `Invoice qty ${fmtNum(invQtySum)} exceeds PO qty ${fmtNum(poOrderedQty)} by ${fmtNum(poExcess)}`;
      if (!qtyMismatchReason) qtyMismatchReason = r;
      reasons.push(r);
    }

    const minExpectedDelivery = poOrderedQty * (1 - qtyTol / 100);
    if (totalGrnQty < minExpectedDelivery) {
      const pendingQty = Number((poOrderedQty - totalGrnQty).toFixed(3));
      const pendingReason = `Pending delivery: ${fmtNum(pendingQty)} not yet received`;
      if (!hasMismatch) {
        hasHold = true;
        mismatchedFields.add('quantity');
        qtyMismatchReason = pendingReason;
      }
      reasons.push(pendingReason);
    }
  }

  // 3. Unit Price check (against current approved PO unit price)
  let priceMismatchReason: string | null = null;
  const invUnitPrice = primaryInvLine ? Number(primaryInvLine.unitPrice) : null;
  if (invUnitPrice === null) {
    hasMismatch = true;
    mismatchedFields.add('unit_price');
    priceMismatchReason = 'Invoice unit price is missing';
    reasons.push(priceMismatchReason);
  } else {
    const allowedDelta = poApprovedPrice * (priceTol / 100);
    if (Math.abs(invUnitPrice - poApprovedPrice) > allowedDelta + 0.0001) {
      hasMismatch = true;
      mismatchedFields.add('unit_price');
      priceMismatchReason = `Invoice unit price ${fmtNum(invUnitPrice)} differs from PO price ${fmtNum(poApprovedPrice)}`;
      reasons.push(priceMismatchReason);
    }
  }

  // Note unapproved PO price modification in comparison metadata without treating unapproved price as approved
  if (primaryPoLine.hasUnapprovedPriceChange) {
    reasons.push(
      `Note: PO has an unapproved unit price change (${fmtNum(poApprovedPrice)} -> ${fmtNum(primaryPoLine.currentUnitPrice)}); matched against approved PO price ${fmtNum(poApprovedPrice)}`
    );
  }

  // 4. Tax check (PO GST rate on invoice taxable subtotal vs actual CGST+SGST+IGST)
  const taxableBase =
    input.invoiceSubtotal !== null
      ? Number(input.invoiceSubtotal)
      : invUnitPrice !== null
      ? Number((invQtySum * invUnitPrice).toFixed(2))
      : null;

  const expectedTaxAmount =
    taxableBase !== null ? Number(((taxableBase * poGstRate) / 100).toFixed(2)) : null;

  let taxMismatchReason: string | null = null;
  if (expectedTaxAmount !== null) {
    const taxToleranceAmount = Math.max(2, expectedTaxAmount * (priceTol / 100));
    if (Math.abs(invTaxAmount - expectedTaxAmount) > taxToleranceAmount) {
      hasMismatch = true;
      mismatchedFields.add('tax');
      taxMismatchReason = `Invoice tax Rs ${fmtNum(invTaxAmount)} differs from expected ${fmtNum(poGstRate)}% GST (Rs ${fmtNum(expectedTaxAmount)})`;
      reasons.push(taxMismatchReason);
    }
  }

  // 5. Total comparison (PO expected total vs invoice total)
  const poExpectedTotal = Number(
    (poOrderedQty * poApprovedPrice * (1 + poGstRate / 100)).toFixed(2)
  );
  let totalMismatchReason: string | null = null;
  if (input.invoiceTotal !== null && taxableBase !== null && expectedTaxAmount !== null) {
    const arithmeticExpectedTotal = Number((taxableBase + invTaxAmount).toFixed(2));
    if (Math.abs(input.invoiceTotal - arithmeticExpectedTotal) > 2) {
      hasMismatch = true;
      mismatchedFields.add('total');
      totalMismatchReason = `Invoice total Rs ${fmtNum(input.invoiceTotal)} does not match subtotal + tax Rs ${fmtNum(arithmeticExpectedTotal)}`;
      reasons.push(totalMismatchReason);
    }
  }

  const finalStatus: MatchStatus = hasMismatch ? 'MISMATCH' : hasHold ? 'HOLD' : 'MATCHED';
  if (finalStatus === 'MATCHED' && reasons.length === 0) {
    reasons.push(
      `Matched within ${qtyTol}% quantity and ${priceTol}% price tolerance (${fmtNum(invQtySum)} ${unitLabel} billed vs ${fmtNum(totalGrnQty)} ${unitLabel} received across ${grnSummaries.length} GRN${grnSummaries.length === 1 ? '' : 's'})`
    );
  }

  const cells: ThreeWayComparisonCell[] = [
    {
      field: 'product',
      label: 'Product / Item',
      poValue: primaryPoLine.description,
      grnValue: input.grns[0]?.description || primaryPoLine.description,
      invoiceValue: primaryInvLine?.description || 'Missing',
      mismatch: mismatchedFields.has('product'),
      reason: productMismatchReason,
    },
    {
      field: 'quantity',
      label: 'Quantity',
      poValue: `${fmtNum(poOrderedQty)} ${unitLabel}`,
      grnValue: `${fmtNum(totalGrnQty)} ${unitLabel} (${grnSummaries.length} GRN${grnSummaries.length === 1 ? '' : 's'})`,
      invoiceValue: `${fmtNum(invQtySum)} ${unitLabel}`,
      mismatch: mismatchedFields.has('quantity'),
      reason: qtyMismatchReason,
    },
    {
      field: 'unit_price',
      label: 'Unit Price (Approved PO)',
      poValue: primaryPoLine.hasUnapprovedPriceChange
        ? `Rs ${fmtNum(poApprovedPrice)}/${unitLabel} (unapproved edit: Rs ${fmtNum(primaryPoLine.currentUnitPrice)})`
        : `Rs ${fmtNum(poApprovedPrice)}/${unitLabel}`,
      grnValue: 'N/A (Qty Only)',
      invoiceValue: invUnitPrice !== null ? `Rs ${fmtNum(invUnitPrice)}/${unitLabel}` : 'Missing',
      mismatch: mismatchedFields.has('unit_price'),
      reason: priceMismatchReason,
    },
    {
      field: 'tax',
      label: `GST / Tax (${fmtNum(poGstRate)}%)`,
      poValue: expectedTaxAmount !== null ? `Rs ${fmtNum(expectedTaxAmount)}` : `${fmtNum(poGstRate)}%`,
      grnValue: 'N/A',
      invoiceValue: `Rs ${fmtNum(invTaxAmount)} (CGST ${fmtNum(input.invoiceCgst)} + SGST ${fmtNum(input.invoiceSgst)} + IGST ${fmtNum(input.invoiceIgst)})`,
      mismatch: mismatchedFields.has('tax'),
      reason: taxMismatchReason,
    },
    {
      field: 'total',
      label: 'Total Amount',
      poValue: `Rs ${fmtNum(poExpectedTotal)} (incl. GST)`,
      grnValue: 'N/A',
      invoiceValue: input.invoiceTotal !== null ? `Rs ${fmtNum(input.invoiceTotal)}` : 'Missing',
      mismatch: mismatchedFields.has('total'),
      reason: totalMismatchReason,
    },
  ];

  return {
    status: finalStatus,
    reasons,
    qtyTolerancePercent: qtyTol,
    priceTolerancePercent: priceTol,
    comparedValues: {
      poNumber: input.poNumber,
      poStatus: input.poStatus,
      poProduct: primaryPoLine.description,
      poOrderedQty,
      poApprovedUnitPrice: poApprovedPrice,
      poCurrentUnitPrice: Number(primaryPoLine.currentUnitPrice),
      poUnapprovedPriceChange: primaryPoLine.hasUnapprovedPriceChange,
      poGstRate,
      poExpectedTotal,
      grnCount: grnSummaries.length,
      grns: grnSummaries,
      grnReceivedQty: totalGrnQty,
      invoiceNumber: input.invoiceNumber,
      invoiceProduct: primaryInvLine?.description ?? null,
      invoiceQty: invQtySum,
      invoiceUnitPrice: invUnitPrice,
      invoiceSubtotal: input.invoiceSubtotal,
      invoiceTaxAmount: invTaxAmount,
      expectedTaxAmount,
      invoiceTotal: input.invoiceTotal,
      mismatchedFields: Array.from(mismatchedFields),
      cells,
    },
  };
}

export interface StoredMatchResultRecord {
  id: number;
  invoice_id: number;
  status: MatchStatus;
  reasons: string[];
  tolerance_percent: string;
  qty_tolerance_percent: string;
  price_tolerance_percent: string;
  compared_values: ThreeWayComparedValues;
  matched_by: number | null;
  evaluated_at: string;
}

async function resolveApprovedPoUnitPrice(
  client: PoolClient,
  poId: number,
  poLineId: number,
  originalUnitPrice: number,
  currentUnitPrice: number
): Promise<{ approvedPrice: number; hasUnapprovedPriceChange: boolean }> {
  const histRes = await client.query<{
    field: string;
    old_value: string;
    new_value: string;
    approval_id: number | null;
    status: string;
  }>(
    `
    SELECT field, old_value, new_value, approval_id, status
    FROM po_change_history
    WHERE po_id = $1
      AND (po_line_id = $2 OR po_line_id IS NULL)
      AND field = 'unit_price'
    ORDER BY changed_at ASC, id ASC;
    `,
    [poId, poLineId]
  );

  if (histRes.rowCount === 0) {
    return { approvedPrice: currentUnitPrice, hasUnapprovedPriceChange: false };
  }

  let hasUnapproved = false;
  let lastApprovedPrice: number | null = null;
  let lastApprovedTimestampIndex = -1;

  histRes.rows.forEach((row, idx) => {
    const isApproved = row.status === 'APPROVED' && row.approval_id !== null;
    if (isApproved) {
      const parsed = Number(row.new_value);
      if (Number.isFinite(parsed)) {
        lastApprovedPrice = parsed;
        lastApprovedTimestampIndex = idx;
      }
    } else if (row.status === 'UNAPPROVED' || row.approval_id === null) {
      hasUnapproved = true;
    }
  });

  // If there is an unapproved modification after the last approved one, use lastApprovedPrice or originalUnitPrice
  const unapprovedAfterLastApproval = histRes.rows.some(
    (row, idx) =>
      idx > lastApprovedTimestampIndex &&
      (row.status === 'UNAPPROVED' || (row.approval_id === null && row.status !== 'REJECTED'))
  );

  if (unapprovedAfterLastApproval) {
    return {
      approvedPrice: lastApprovedPrice !== null ? lastApprovedPrice : originalUnitPrice,
      hasUnapprovedPriceChange: true,
    };
  }

  return {
    approvedPrice: currentUnitPrice,
    hasUnapprovedPriceChange: hasUnapproved,
  };
}

/**
 * Runs real 3-way matching (PO + summed GRNs + Invoice), updates invoice status
 * (MATCHED or ON_HOLD; never approves payment), saves to match_results, and writes audit_log.
 */
export async function matchInvoice(
  invoiceId: number,
  actorId: number | null = null,
  externalClient?: PoolClient
): Promise<{
  matchResult: StoredMatchResultRecord;
  invoiceStatus: string;
}> {
  const pool = getPool();
  const ownsClient = !externalClient;
  const client = externalClient ?? (await pool.connect());

  try {
    if (ownsClient) {
      await client.query('BEGIN');
    }

    const invRes = await client.query<{
      id: number;
      invoice_number: string | null;
      po_id: number | null;
      po_reference_extracted: string | null;
      subtotal: string | null;
      cgst: string | null;
      sgst: string | null;
      igst: string | null;
      total: string | null;
      status: string;
    }>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);

    if (invRes.rowCount === 0) {
      throw new HttpError(404, `Invoice #${invoiceId} not found.`);
    }
    const invoice = invRes.rows[0];

    // Resolve PO by po_id or fallback lookup by po_reference_extracted
    let poId = invoice.po_id;
    if (!poId && invoice.po_reference_extracted) {
      const poLookup = await client.query<{ id: number }>(
        'SELECT id FROM purchase_orders WHERE UPPER(po_number) = $1 LIMIT 1',
        [invoice.po_reference_extracted.trim().toUpperCase()]
      );
      if (poLookup.rows[0]) {
        poId = poLookup.rows[0].id;
        await client.query('UPDATE invoices SET po_id = $1 WHERE id = $2', [poId, invoiceId]);
      }
    }

    // Load configurable tolerance thresholds from risk_rules_config
    const rulesRes = await client.query<{ rule_code: string; threshold: string }>(
      `
      SELECT rule_code, threshold
      FROM risk_rules_config
      WHERE rule_code IN ('QTY_MISMATCH', 'PRICE_MISMATCH') AND is_active = TRUE;
      `
    );
    let qtyTol = 2.0;
    let priceTol = 2.0;
    for (const r of rulesRes.rows) {
      if (r.rule_code === 'QTY_MISMATCH') {
        qtyTol = Number(r.threshold);
      } else if (r.rule_code === 'PRICE_MISMATCH') {
        priceTol = Number(r.threshold);
      }
    }

    // Load invoice lines
    const invLinesRes = await client.query<{
      id: number;
      description: string;
      hsn_sac: string | null;
      quantity: string;
      unit: string;
      unit_price: string;
      tax_rate: string;
      line_total: string;
    }>('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number ASC, id ASC', [
      invoiceId,
    ]);

    const invoiceLines: ThreeWayInvoiceLineInput[] = invLinesRes.rows.map((l) => ({
      id: l.id,
      description: l.description,
      hsnSac: l.hsn_sac,
      quantity: Number(l.quantity),
      unit: l.unit,
      unitPrice: Number(l.unit_price),
      taxRate: Number(l.tax_rate || 18),
      lineTotal: Number(l.line_total),
    }));

    let poNumber: string | null = null;
    let poStatus: string | null = null;
    const poLines: ThreeWayPoLineInput[] = [];
    const grns: ThreeWayGrnInput[] = [];

    if (poId) {
      const poRes = await client.query<{
        id: number;
        po_number: string;
        status: string;
      }>('SELECT id, po_number, status FROM purchase_orders WHERE id = $1 LIMIT 1', [poId]);

      if (poRes.rows[0]) {
        poNumber = poRes.rows[0].po_number;
        poStatus = poRes.rows[0].status;

        const poLinesRes = await client.query<{
          id: number;
          description: string;
          hsn_sac: string | null;
          current_quantity: string;
          unit: string;
          original_unit_price: string;
          current_unit_price: string;
          gst_rate: string;
        }>('SELECT * FROM po_lines WHERE po_id = $1 ORDER BY line_number ASC, id ASC', [poId]);

        for (const pl of poLinesRes.rows) {
          const { approvedPrice, hasUnapprovedPriceChange } = await resolveApprovedPoUnitPrice(
            client,
            poId,
            pl.id,
            Number(pl.original_unit_price),
            Number(pl.current_unit_price)
          );
          poLines.push({
            id: pl.id,
            description: pl.description,
            hsnSac: pl.hsn_sac,
            orderedQuantity: Number(pl.current_quantity),
            unit: pl.unit,
            approvedUnitPrice: approvedPrice,
            currentUnitPrice: Number(pl.current_unit_price),
            hasUnapprovedPriceChange,
            gstRate: Number(pl.gst_rate || 18),
          });
        }

        const grnRes = await client.query<{
          grn_id: number;
          grn_number: string;
          received_at: Date | string;
          po_line_id: number | null;
          description: string;
          quantity_received: string;
          unit: string;
        }>(
          `
          SELECT
            g.id AS grn_id,
            g.grn_number,
            g.received_at,
            gl.po_line_id,
            gl.description,
            gl.quantity_received,
            gl.unit
          FROM grns g
          JOIN grn_lines gl ON gl.grn_id = g.id
          WHERE g.po_id = $1
            AND COALESCE(g.status, 'RECEIVED') <> 'SUPERSEDED'
          ORDER BY g.received_at ASC, g.id ASC, gl.id ASC;
          `,
          [poId]
        );

        for (const g of grnRes.rows) {
          grns.push({
            grnId: g.grn_id,
            grnNumber: g.grn_number,
            receivedAt:
              g.received_at instanceof Date ? g.received_at.toISOString() : String(g.received_at),
            poLineId: g.po_line_id,
            description: g.description,
            quantityReceived: Number(g.quantity_received),
            unit: g.unit,
          });
        }
      }
    }

    const evaluation = evaluateThreeWayMatch({
      poNumber,
      poStatus,
      poLines,
      grns,
      invoiceNumber: invoice.invoice_number,
      invoiceSubtotal: invoice.subtotal !== null ? Number(invoice.subtotal) : null,
      invoiceCgst: Number(invoice.cgst || 0),
      invoiceSgst: Number(invoice.sgst || 0),
      invoiceIgst: Number(invoice.igst || 0),
      invoiceTotal: invoice.total !== null ? Number(invoice.total) : null,
      invoiceLines,
      qtyTolerancePercent: qtyTol,
      priceTolerancePercent: priceTol,
    });

    const insertRes = await client.query<StoredMatchResultRecord>(
      `
      INSERT INTO match_results (
        invoice_id, status, reasons, tolerance_percent,
        qty_tolerance_percent, price_tolerance_percent,
        compared_values, matched_by, is_sample_data
      )
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8, TRUE)
      RETURNING *;
      `,
      [
        invoiceId,
        evaluation.status,
        JSON.stringify(evaluation.reasons),
        evaluation.qtyTolerancePercent,
        evaluation.qtyTolerancePercent,
        evaluation.priceTolerancePercent,
        JSON.stringify(evaluation.comparedValues),
        actorId,
      ]
    );

    // Golden rule: any MISMATCH or HOLD sets invoice to ON_HOLD; never release or approve payment.
    const nextInvoiceStatus = evaluation.status === 'MATCHED' ? 'MATCHED' : 'ON_HOLD';
    if (invoice.status !== 'PAID') {
      await client.query('UPDATE invoices SET status = $1 WHERE id = $2', [
        nextInvoiceStatus,
        invoiceId,
      ]);
    }

    await writeAuditLog(
      actorId,
      'INVOICE_MATCHED',
      'match_results',
      insertRes.rows[0].id,
      {
        invoiceId,
        invoiceNumber: invoice.invoice_number,
        poNumber,
        matchStatus: evaluation.status,
        invoiceStatus: invoice.status === 'PAID' ? 'PAID' : nextInvoiceStatus,
        reasons: evaluation.reasons,
        qtyTolerancePercent: evaluation.qtyTolerancePercent,
        priceTolerancePercent: evaluation.priceTolerancePercent,
      },
      client
    );

    if (ownsClient) {
      await client.query('COMMIT');
    }

    return {
      matchResult: insertRes.rows[0],
      invoiceStatus: invoice.status === 'PAID' ? 'PAID' : nextInvoiceStatus,
    };
  } catch (err) {
    if (ownsClient) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

export async function getLatestMatchResult(
  invoiceId: number
): Promise<StoredMatchResultRecord | null> {
  const invCheck = await query<{ id: number }>('SELECT id FROM invoices WHERE id = $1 LIMIT 1', [
    invoiceId,
  ]);
  if (invCheck.rowCount === 0) {
    throw new HttpError(404, `Invoice #${invoiceId} not found.`);
  }

  const res = await query<StoredMatchResultRecord>(
    `
    SELECT *
    FROM match_results
    WHERE invoice_id = $1
    ORDER BY evaluated_at DESC, id DESC
    LIMIT 1;
    `,
    [invoiceId]
  );

  return res.rows[0] ?? null;
}
