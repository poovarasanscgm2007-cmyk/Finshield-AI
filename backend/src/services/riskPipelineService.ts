import { PoolClient } from 'pg';
import { getPool, query } from '../db/pool.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { normalizeInvoiceNumber } from '../utils/invoiceNormalizer.ts';
import { writeAuditLog } from './auditService.ts';
import { detectDuplicatesForInvoice, DuplicateDetectionResult } from './duplicateService.ts';
import { validateGstin, validateGstTaxType } from './gstValidation.ts';
import { matchInvoice, StoredMatchResultRecord } from './matchingService.ts';

export type PipelineIssueType =
  | 'QUANTITY_MISMATCH'
  | 'PRICE_MISMATCH'
  | 'POSSIBLE_DUPLICATE'
  | 'UNAPPROVED_PO_CHANGE'
  | 'REPEATED_OVERBILLING'
  | 'GST_ITC_RISK'
  | 'SUPPLIER_RISK';

export type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ActivePipelineIssue {
  issueType: PipelineIssueType;
  ruleCodes: string[];
  severity: SeverityLevel;
  title: string;
  description: string;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export interface PipelineFlagRecord {
  ruleCode: string;
  ruleName: string;
  severity: SeverityLevel;
  weight: number;
  reason: string;
  metadata: Record<string, unknown>;
}

export interface FullPipelineResult {
  invoiceId: number;
  invoiceNumber: string | null;
  supplierId: number | null;
  poId: number | null;
  matchResult: StoredMatchResultRecord;
  duplicates: DuplicateDetectionResult;
  riskScore: number;
  riskLevel: SeverityLevel;
  itcAtRisk: number;
  flags: PipelineFlagRecord[];
  activeIssues: ActivePipelineIssue[];
  evaluatedAt: string;
}

interface RuleConfigRow {
  rule_code: string;
  rule_name: string;
  weight: string;
  threshold: string;
  is_active: boolean;
}

function severityRank(sev: SeverityLevel): number {
  switch (sev) {
    case 'CRITICAL':
      return 4;
    case 'HIGH':
      return 3;
    case 'MEDIUM':
      return 2;
    default:
      return 1;
  }
}

function maxSeverity(a: SeverityLevel, b: SeverityLevel): SeverityLevel {
  return severityRank(a) >= severityRank(b) ? a : b;
}

function riskLevelFromScore(score: number): SeverityLevel {
  if (score >= 45) return 'HIGH';
  if (score >= 20) return 'MEDIUM';
  return 'LOW';
}

export async function runFullInvoicePipeline(
  invoiceId: number,
  actorId: number | null = null,
  externalClient?: PoolClient
): Promise<FullPipelineResult> {
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
      normalized_invoice_number: string | null;
      irn: string | null;
      supplier_id: number | null;
      supplier_name_extracted: string | null;
      supplier_gstin_extracted: string | null;
      po_id: number | null;
      po_reference_extracted: string | null;
      bank_identifier_extracted: string | null;
      invoice_date: Date | string | null;
      subtotal: string | null;
      cgst: string | null;
      sgst: string | null;
      igst: string | null;
      extra_charges: string | null;
      total: string | null;
      status: string;
      is_historical: boolean;
    }>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);

    if (invRes.rowCount === 0) {
      throw new HttpError(404, `Invoice #${invoiceId} not found.`);
    }
    const invoice = invRes.rows[0];

    // Resolve supplier_id if missing using extracted GSTIN or name
    let supplierId = invoice.supplier_id;
    if (!supplierId && invoice.supplier_gstin_extracted) {
      const supLookup = await client.query<{ id: number }>(
        'SELECT id FROM suppliers WHERE UPPER(gstin) = $1 LIMIT 1',
        [invoice.supplier_gstin_extracted.trim().toUpperCase()]
      );
      if (supLookup.rows[0]) {
        supplierId = supLookup.rows[0].id;
        await client.query('UPDATE invoices SET supplier_id = $1 WHERE id = $2', [
          supplierId,
          invoiceId,
        ]);
      }
    }

    // Load active configurable risk rules
    const rulesRes = await client.query<RuleConfigRow>(
      'SELECT rule_code, rule_name, weight, threshold, is_active FROM risk_rules_config WHERE is_active = TRUE'
    );
    const rulesMap = new Map<string, { ruleName: string; weight: number; threshold: number }>();
    for (const r of rulesRes.rows) {
      rulesMap.set(r.rule_code, {
        ruleName: r.rule_name,
        weight: Number(r.weight),
        threshold: Number(r.threshold),
      });
    }

    const getRule = (code: string, defaultWeight: number, defaultThreshold: number) =>
      rulesMap.get(code) ?? {
        ruleName: code,
        weight: defaultWeight,
        threshold: defaultThreshold,
      };

    // 1. Run 3-Way Match inside transaction
    const matchOutcome = await matchInvoice(invoiceId, actorId, client);
    const matchResult = matchOutcome.matchResult;

    // Reload PO ID in case matchInvoice resolved po_id from po_reference_extracted
    const invPoRes = await client.query<{ po_id: number | null }>(
      'SELECT po_id FROM invoices WHERE id = $1',
      [invoiceId]
    );
    const poId = invPoRes.rows[0]?.po_id ?? invoice.po_id;

    // Load supplier & PO buyer details
    interface SupplierPipelineRow {
      id: number;
      supplier_code: string;
      name: string;
      gstin: string;
      pan: string;
      state_code: string;
      bank_identifier: string;
      gst_filing_status: string;
    }

    let supplier: SupplierPipelineRow | null = null;

    if (supplierId) {
      const sRes = await client.query<SupplierPipelineRow>(
        'SELECT id, supplier_code, name, gstin, pan, state_code, bank_identifier, gst_filing_status FROM suppliers WHERE id = $1 LIMIT 1',
        [supplierId]
      );
      supplier = sRes.rows[0] ?? null;
    }

    let buyerStateCode = '27';
    let poNumber: string | null = matchResult.compared_values?.poNumber ?? null;
    if (poId) {
      const poRes = await client.query<{ po_number: string; buyer_state_code: string }>(
        'SELECT po_number, buyer_state_code FROM purchase_orders WHERE id = $1 LIMIT 1',
        [poId]
      );
      if (poRes.rows[0]) {
        poNumber = poRes.rows[0].po_number;
        buyerStateCode = poRes.rows[0].buyer_state_code || '27';
      }
    }

    // 2. Run Duplicate Detection
    const duplicates = await detectDuplicatesForInvoice(invoiceId);

    const flags: PipelineFlagRecord[] = [];
    const activeIssuesMap = new Map<PipelineIssueType, ActivePipelineIssue>();

    const addIssueFlag = (params: {
      issueType: PipelineIssueType;
      ruleCode: string;
      ruleName: string;
      weight: number;
      severity: SeverityLevel;
      title: string;
      reason: string;
      metadata: Record<string, unknown>;
      evidencePatch: Record<string, unknown>;
    }) => {
      flags.push({
        ruleCode: params.ruleCode,
        ruleName: params.ruleName,
        severity: params.severity,
        weight: params.weight,
        reason: params.reason,
        metadata: params.metadata,
      });

      const existing = activeIssuesMap.get(params.issueType);
      if (existing) {
        existing.ruleCodes = Array.from(new Set([...existing.ruleCodes, params.ruleCode]));
        existing.severity = maxSeverity(existing.severity, params.severity);
        if (!existing.reasons.includes(params.reason)) {
          existing.reasons.push(params.reason);
        }
        existing.description = existing.reasons.join('; ');
        existing.evidence = { ...existing.evidence, ...params.evidencePatch };
      } else {
        activeIssuesMap.set(params.issueType, {
          issueType: params.issueType,
          ruleCodes: [params.ruleCode],
          severity: params.severity,
          title: params.title,
          description: params.reason,
          reasons: [params.reason],
          evidence: {
            invoiceId,
            invoiceNumber: invoice.invoice_number,
            supplierId,
            poId,
            poNumber,
            ...params.evidencePatch,
          },
        });
      }
    };

    // --- Check A: 3-Way Quantity Mismatch ---
    const mismatchedFields = matchResult.compared_values?.mismatchedFields || [];
    if (mismatchedFields.includes('quantity')) {
      const rule = getRule('QTY_MISMATCH', 25, 2);
      const qtyCell = matchResult.compared_values?.cells?.find((c) => c.field === 'quantity');
      const reason =
        qtyCell?.reason ||
        matchResult.reasons.find((r) => r.toLowerCase().includes('qty') || r.toLowerCase().includes('received') || r.toLowerCase().includes('delivery')) ||
        'Quantity mismatch detected during 3-way matching';

      addIssueFlag({
        issueType: 'QUANTITY_MISMATCH',
        ruleCode: 'QTY_MISMATCH',
        ruleName: rule.ruleName,
        weight: rule.weight,
        severity: 'HIGH',
        title: `Quantity Mismatch on ${invoice.invoice_number || `Invoice #${invoiceId}`}`,
        reason,
        metadata: {
          matchResultId: matchResult.id,
          poOrderedQty: matchResult.compared_values?.poOrderedQty,
          grnReceivedQty: matchResult.compared_values?.grnReceivedQty,
          invoiceQty: matchResult.compared_values?.invoiceQty,
          grns: matchResult.compared_values?.grns,
        },
        evidencePatch: {
          matchResultId: matchResult.id,
          poOrderedQty: matchResult.compared_values?.poOrderedQty,
          grnReceivedQty: matchResult.compared_values?.grnReceivedQty,
          invoiceQty: matchResult.compared_values?.invoiceQty,
          quantityGap:
            matchResult.compared_values?.invoiceQty != null &&
            matchResult.compared_values?.grnReceivedQty != null
              ? Number(
                  (
                    matchResult.compared_values.invoiceQty -
                    matchResult.compared_values.grnReceivedQty
                  ).toFixed(3)
                )
              : null,
          grns: matchResult.compared_values?.grns || [],
        },
      });
    }

    // --- Check B: 3-Way Unit Price Mismatch ---
    if (mismatchedFields.includes('unit_price')) {
      const rule = getRule('PRICE_MISMATCH', 20, 2);
      const priceCell = matchResult.compared_values?.cells?.find((c) => c.field === 'unit_price');
      const reason =
        priceCell?.reason || 'Invoice unit price differs from approved Purchase Order unit price';

      addIssueFlag({
        issueType: 'PRICE_MISMATCH',
        ruleCode: 'PRICE_MISMATCH',
        ruleName: rule.ruleName,
        weight: rule.weight,
        severity: 'HIGH',
        title: `Unit Price Mismatch on ${invoice.invoice_number || `Invoice #${invoiceId}`}`,
        reason,
        metadata: {
          matchResultId: matchResult.id,
          poApprovedUnitPrice: matchResult.compared_values?.poApprovedUnitPrice,
          invoiceUnitPrice: matchResult.compared_values?.invoiceUnitPrice,
        },
        evidencePatch: {
          matchResultId: matchResult.id,
          poApprovedUnitPrice: matchResult.compared_values?.poApprovedUnitPrice,
          invoiceUnitPrice: matchResult.compared_values?.invoiceUnitPrice,
        },
      });
    }

    // --- Check C: Unapproved PO Modification Monitoring ---
    if (poId && rulesMap.has('UNAPPROVED_PO_CHANGE')) {
      const rule = getRule('UNAPPROVED_PO_CHANGE', 25, 1);
      const poChangesRes = await client.query<{
        id: number;
        field: string;
        old_value: string;
        new_value: string;
        status: string;
        approval_id: number | null;
        changed_by: number;
        changed_by_name: string;
        changed_at: Date | string;
        reason: string | null;
      }>(
        `
        SELECT
          pch.id, pch.field, pch.old_value, pch.new_value, pch.status,
          pch.approval_id, pch.changed_by, u.name AS changed_by_name,
          pch.changed_at, pch.reason
        FROM po_change_history pch
        JOIN users u ON u.id = pch.changed_by
        WHERE pch.po_id = $1
          AND (pch.approval_id IS NULL OR pch.status = 'UNAPPROVED')
        ORDER BY pch.changed_at DESC, pch.id DESC;
        `,
        [poId]
      );

      if (poChangesRes.rows.length > 0) {
        const primaryChange = poChangesRes.rows[0];
        const reason = `${poNumber || `PO #${poId}`} ${primaryChange.field} modified from Rs ${primaryChange.old_value} to Rs ${primaryChange.new_value} by ${primaryChange.changed_by_name} with no approval record`;

        addIssueFlag({
          issueType: 'UNAPPROVED_PO_CHANGE',
          ruleCode: 'UNAPPROVED_PO_CHANGE',
          ruleName: rule.ruleName,
          weight: rule.weight,
          severity: 'CRITICAL',
          title: `Unapproved PO Change on ${poNumber || `PO #${poId}`}`,
          reason,
          metadata: {
            poId,
            poNumber,
            unapprovedChanges: poChangesRes.rows,
          },
          evidencePatch: {
            poId,
            poNumber,
            poChangeHistoryIds: poChangesRes.rows.map((c) => c.id),
            changedByUserIds: poChangesRes.rows.map((c) => c.changed_by),
            changes: poChangesRes.rows.map((c) => ({
              historyId: c.id,
              field: c.field,
              oldValue: c.old_value,
              newValue: c.new_value,
              changedById: c.changed_by,
              changedByName: c.changed_by_name,
              status: c.status,
              approvalId: c.approval_id,
            })),
          },
        });
      }
    }

    // --- Check D: Duplicate Invoice Detection ---
    if (duplicates.hasPossibleDuplicates && rulesMap.has('DUPLICATE_INVOICE')) {
      const rule = getRule('DUPLICATE_INVOICE', 20, 0.65);
      const top = duplicates.possibleDuplicates[0];
      const reason = `Possible duplicate of ${top.candidateInvoiceNumber || `Invoice #${top.candidateInvoiceId}`} (${Math.round(
        duplicates.highestScore * 100
      )}% similarity — ${top.reasons.join(', ')})`;

      addIssueFlag({
        issueType: 'POSSIBLE_DUPLICATE',
        ruleCode: 'DUPLICATE_INVOICE',
        ruleName: rule.ruleName,
        weight: rule.weight,
        severity: 'HIGH',
        title: `Possible Duplicate Invoice (${invoice.invoice_number || `#${invoiceId}`})`,
        reason,
        metadata: {
          highestScore: duplicates.highestScore,
          threshold: duplicates.threshold,
          candidateIds: duplicates.possibleDuplicates.map((d) => d.candidateInvoiceId),
        },
        evidencePatch: {
          duplicateScore: duplicates.highestScore,
          duplicateThreshold: duplicates.threshold,
          duplicateCandidates: duplicates.possibleDuplicates.map((d) => ({
            invoiceId: d.candidateInvoiceId,
            invoiceNumber: d.candidateInvoiceNumber,
            similarityScore: d.similarityScore,
            reasons: d.reasons,
          })),
        },
      });
    }

    // --- Check E: Historical Extra Charges / Repeated Overbilling ---
    if (supplierId && rulesMap.has('HISTORICAL_OVERBILLING')) {
      const rule = getRule('HISTORICAL_OVERBILLING', 15, 3);
      const histExtraRes = await client.query<{
        id: number;
        invoice_number: string;
        invoice_date: Date | string;
        extra_charges: string;
      }>(
        `
        SELECT id, invoice_number, invoice_date, extra_charges
        FROM invoices
        WHERE supplier_id = $1
          AND id <> $2
          AND COALESCE(extra_charges, 0) > 0
        ORDER BY invoice_date DESC, id DESC;
        `,
        [supplierId, invoiceId]
      );

      if (histExtraRes.rows.length >= rule.threshold) {
        const amounts = histExtraRes.rows.map((r) => Number(r.extra_charges));
        const uniqueAmounts = Array.from(new Set(amounts)).sort((a, b) => a - b);
        const totalExtra = amounts.reduce((sum, a) => sum + a, 0);
        const reason = `${supplier?.name || `Supplier #${supplierId}`} has repeated extra charges (${uniqueAmounts
          .map((a) => `Rs ${a}`)
          .join(', ')}) across ${histExtraRes.rows.length} past invoices totaling Rs ${totalExtra.toFixed(2)}`;

        addIssueFlag({
          issueType: 'REPEATED_OVERBILLING',
          ruleCode: 'HISTORICAL_OVERBILLING',
          ruleName: rule.ruleName,
          weight: rule.weight,
          severity: 'MEDIUM',
          title: `Repeated Extra Charges Pattern (${supplier?.supplier_code || `Supplier #${supplierId}`})`,
          reason,
          metadata: {
            supplierId,
            pastInvoicesWithExtraCharges: histExtraRes.rows.length,
            uniqueExtraChargeAmounts: uniqueAmounts,
            totalHistoricalExtraCharges: totalExtra,
          },
          evidencePatch: {
            historicalInvoiceIds: histExtraRes.rows.map((r) => r.id),
            historicalInvoiceNumbers: histExtraRes.rows.map((r) => r.invoice_number),
            uniqueExtraChargeAmounts: uniqueAmounts,
            totalHistoricalExtraCharges: totalExtra,
            occurrences: histExtraRes.rows.length,
          },
        });
      }
    }

    // --- Check F: GST Compliance & ITC at Risk ---
    const activeGstin = (invoice.supplier_gstin_extracted || supplier?.gstin || '').trim().toUpperCase();
    const cgst = Number(invoice.cgst || 0);
    const sgst = Number(invoice.sgst || 0);
    const igst = Number(invoice.igst || 0);
    const totalTax = Number((cgst + sgst + igst).toFixed(2));
    let itcAtRisk = 0;

    // F1: GSTIN Format + Mod-36 Checksum
    const gstinCheck = validateGstin(activeGstin);
    if ((!gstinCheck.formatValid || !gstinCheck.checksumValid) && rulesMap.has('GSTIN_INVALID')) {
      const rule = getRule('GSTIN_INVALID', 20, 1);
      itcAtRisk = totalTax;
      addIssueFlag({
        issueType: 'GST_ITC_RISK',
        ruleCode: 'GSTIN_INVALID',
        ruleName: rule.ruleName,
        weight: rule.weight,
        severity: 'HIGH',
        title: `GST & ITC Compliance Risk on ${invoice.invoice_number || `#${invoiceId}`}`,
        reason: gstinCheck.reason || 'Supplier GSTIN failed checksum validation',
        metadata: { gstin: activeGstin, formatValid: gstinCheck.formatValid, checksumValid: gstinCheck.checksumValid },
        evidencePatch: {
          gstin: activeGstin,
          gstinFormatValid: gstinCheck.formatValid,
          gstinChecksumValid: gstinCheck.checksumValid,
        },
      });
    }

    // F2: Intra-state CGST+SGST vs Inter-state IGST
    const supplierState = gstinCheck.stateCode || supplier?.state_code || null;
    const taxTypeCheck = validateGstTaxType({
      supplierStateCode: supplierState,
      buyerStateCode,
      cgst,
      sgst,
      igst,
    });
    if (!taxTypeCheck.valid && rulesMap.has('GST_TAX_TYPE_MISMATCH')) {
      const rule = getRule('GST_TAX_TYPE_MISMATCH', 15, 0.01);
      itcAtRisk = Math.max(itcAtRisk, totalTax);
      addIssueFlag({
        issueType: 'GST_ITC_RISK',
        ruleCode: 'GST_TAX_TYPE_MISMATCH',
        ruleName: rule.ruleName,
        weight: rule.weight,
        severity: 'HIGH',
        title: `GST & ITC Compliance Risk on ${invoice.invoice_number || `#${invoiceId}`}`,
        reason: taxTypeCheck.reason!,
        metadata: { supplierState, buyerStateCode, cgst, sgst, igst },
        evidencePatch: { supplierState, buyerStateCode, cgst, sgst, igst },
      });
    }

    // F3: GSTR-2B vs Purchase Register Verification -> Compute exact ITC at Risk (INR)
    const normInv =
      invoice.normalized_invoice_number || normalizeInvoiceNumber(invoice.invoice_number);
    let gstr2bMatchedId: number | null = null;
    if (normInv && activeGstin && rulesMap.has('GSTR2B_MISSING')) {
      const rule = getRule('GSTR2B_MISSING', 20, 1);
      const gstrRes = await client.query<{
        id: number;
        return_period: string;
        taxable_value: string;
        cgst: string;
        sgst: string;
        igst: string;
        itc_available: boolean;
      }>(
        `
        SELECT id, return_period, taxable_value, cgst, sgst, igst, itc_available
        FROM gstr2b_records
        WHERE UPPER(supplier_gstin) = $1
          AND normalized_invoice_number = $2
        ORDER BY id DESC
        LIMIT 1;
        `,
        [activeGstin, normInv]
      );

      const gstrRow = gstrRes.rows[0];
      if (!gstrRow) {
        itcAtRisk = totalTax;
        addIssueFlag({
          issueType: 'GST_ITC_RISK',
          ruleCode: 'GSTR2B_MISSING',
          ruleName: rule.ruleName,
          weight: rule.weight,
          severity: 'HIGH',
          title: `GST & ITC Compliance Risk on ${invoice.invoice_number || `#${invoiceId}`}`,
          reason: `Invoice ${invoice.invoice_number || `#${invoiceId}`} not found in GSTR-2B for GSTIN ${activeGstin} — ITC at risk: Rs ${totalTax.toFixed(2)}`,
          metadata: { activeGstin, normalizedInvoiceNumber: normInv, itcAtRisk: totalTax, gstr2bFound: false },
          evidencePatch: {
            gstr2bFound: false,
            supplierGstin: activeGstin,
            itcAtRiskInr: totalTax,
          },
        });
      } else {
        gstr2bMatchedId = gstrRow.id;
        const gstrTax = Number(gstrRow.cgst || 0) + Number(gstrRow.sgst || 0) + Number(gstrRow.igst || 0);
        if (!gstrRow.itc_available || Math.abs(gstrTax - totalTax) > 2) {
          const taxDelta = !gstrRow.itc_available ? totalTax : Math.max(0, Number((totalTax - gstrTax).toFixed(2)));
          itcAtRisk = Math.max(itcAtRisk, taxDelta || totalTax);
          addIssueFlag({
            issueType: 'GST_ITC_RISK',
            ruleCode: 'GSTR2B_MISSING',
            ruleName: rule.ruleName,
            weight: rule.weight,
            severity: 'HIGH',
            title: `GST & ITC Compliance Risk on ${invoice.invoice_number || `#${invoiceId}`}`,
            reason: !gstrRow.itc_available
              ? `GSTR-2B record #${gstrRow.id} marks ITC unavailable — ITC at risk: Rs ${itcAtRisk.toFixed(2)}`
              : `GSTR-2B tax Rs ${gstrTax.toFixed(2)} differs from invoice tax Rs ${totalTax.toFixed(2)} — ITC at risk: Rs ${itcAtRisk.toFixed(2)}`,
            metadata: { gstr2bId: gstrRow.id, gstrTax, invoiceTax: totalTax, itcAtRisk },
            evidencePatch: { gstr2bId: gstrRow.id, itcAtRiskInr: itcAtRisk },
          });
        }
      }
    }

    // F4: Supplier GST Filing Status Risk
    if (
      supplier &&
      ['DELAYED_FILER', 'NON_FILER', 'SUSPENDED'].includes(
        (supplier.gst_filing_status || '').toUpperCase()
      ) &&
      rulesMap.has('SUPPLIER_FILING_RISK')
    ) {
      const rule = getRule('SUPPLIER_FILING_RISK', 15, 1);
      addIssueFlag({
        issueType: 'GST_ITC_RISK',
        ruleCode: 'SUPPLIER_FILING_RISK',
        ruleName: rule.ruleName,
        weight: rule.weight,
        severity: 'MEDIUM',
        title: `GST & ITC Compliance Risk on ${invoice.invoice_number || `#${invoiceId}`}`,
        reason: `${supplier.name} GST filing status is ${supplier.gst_filing_status}, elevating ITC reversal risk`,
        metadata: { supplierId: supplier.id, gstFilingStatus: supplier.gst_filing_status },
        evidencePatch: {
          supplierId: supplier.id,
          gstFilingStatus: supplier.gst_filing_status,
          gstr2bId: gstr2bMatchedId,
        },
      });
    }

    // --- Check G: Supplier Shared Bank Identifier Risk ---
    if (supplier && supplier.bank_identifier && rulesMap.has('SHARED_BANK_IDENTIFIER')) {
      const rule = getRule('SHARED_BANK_IDENTIFIER', 15, 2);
      const sharedRes = await client.query<{
        id: number;
        supplier_code: string;
        name: string;
        gstin: string;
      }>(
        `
        SELECT id, supplier_code, name, gstin
        FROM suppliers
        WHERE bank_identifier = $1
        ORDER BY id ASC;
        `,
        [supplier.bank_identifier]
      );

      if (sharedRes.rows.length >= rule.threshold) {
        const otherNames = sharedRes.rows
          .filter((s) => s.id !== supplier!.id)
          .map((s) => `${s.name} (${s.supplier_code})`);
        const reason = `${supplier.name} shares bank identifier ${supplier.bank_identifier} with ${otherNames.join(', ')} — requires verification`;

        addIssueFlag({
          issueType: 'SUPPLIER_RISK',
          ruleCode: 'SHARED_BANK_IDENTIFIER',
          ruleName: rule.ruleName,
          weight: rule.weight,
          severity: 'MEDIUM',
          title: `Shared Supplier Bank Identifier (${supplier.supplier_code})`,
          reason,
          metadata: {
            bankIdentifier: supplier.bank_identifier,
            linkedSupplierIds: sharedRes.rows.map((s) => s.id),
          },
          evidencePatch: {
            bankIdentifier: supplier.bank_identifier,
            linkedSuppliers: sharedRes.rows,
          },
        });
      }
    }

    // Compute Composite Explainable Risk Priority Score (0 - 100)
    const rawScore = flags.reduce((sum, f) => sum + Number(f.weight || 0), 0);
    const riskScore = Number(Math.min(100, rawScore).toFixed(2));
    const riskLevel = riskLevelFromScore(riskScore);

    // Sync risk_flags cleanly: mark prior active flags for this invoice resolved, then insert current active flags
    await client.query(
      `
      UPDATE risk_flags
      SET is_resolved = TRUE
      WHERE entity_type = 'invoice' AND entity_id = $1 AND is_resolved = FALSE;
      `,
      [invoiceId]
    );

    for (const flag of flags) {
      await client.query(
        `
        INSERT INTO risk_flags (
          entity_type, entity_id, rule_code, severity, reason, score, metadata, is_resolved, is_sample_data
        )
        VALUES ('invoice', $1, $2, $3, $4, $5, $6::jsonb, FALSE, TRUE);
        `,
        [
          invoiceId,
          flag.ruleCode,
          flag.severity,
          flag.reason,
          flag.weight,
          JSON.stringify(flag.metadata),
        ]
      );
    }

    await client.query(
      `
      UPDATE invoices
      SET risk_score = $1,
          risk_level = $2,
          itc_at_risk = $3
      WHERE id = $4;
      `,
      [riskScore, riskLevel, itcAtRisk, invoiceId]
    );

    const activeIssues = Array.from(activeIssuesMap.values());

    await writeAuditLog(
      actorId,
      'RISK_PIPELINE_EVALUATED',
      'invoices',
      invoiceId,
      {
        invoiceNumber: invoice.invoice_number,
        matchStatus: matchResult.status,
        riskScore,
        riskLevel,
        itcAtRisk,
        activeIssueTypes: activeIssues.map((i) => i.issueType),
        flagCount: flags.length,
      },
      client
    );

    if (ownsClient) {
      await client.query('COMMIT');
    }

    return {
      invoiceId,
      invoiceNumber: invoice.invoice_number,
      supplierId,
      poId,
      matchResult,
      duplicates,
      riskScore,
      riskLevel,
      itcAtRisk,
      flags,
      activeIssues,
      evaluatedAt: new Date().toISOString(),
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

export async function getInvoiceRiskSummary(invoiceId: number): Promise<{
  invoiceId: number;
  riskScore: number;
  riskLevel: SeverityLevel;
  itcAtRisk: number;
  flags: Array<{
    id: number;
    rule_code: string;
    severity: SeverityLevel;
    reason: string;
    score: string;
    metadata: Record<string, unknown>;
    is_resolved: boolean;
    created_at: string;
  }>;
}> {
  const invRes = await query<{
    id: number;
    risk_score: string;
    risk_level: SeverityLevel;
    itc_at_risk: string;
  }>('SELECT id, risk_score, risk_level, itc_at_risk FROM invoices WHERE id = $1 LIMIT 1', [
    invoiceId,
  ]);

  if (invRes.rowCount === 0) {
    throw new HttpError(404, `Invoice #${invoiceId} not found.`);
  }

  const flagsRes = await query<{
    id: number;
    rule_code: string;
    severity: SeverityLevel;
    reason: string;
    score: string;
    metadata: Record<string, unknown>;
    is_resolved: boolean;
    created_at: string;
  }>(
    `
    SELECT id, rule_code, severity, reason, score, metadata, is_resolved, created_at
    FROM risk_flags
    WHERE entity_type = 'invoice' AND entity_id = $1 AND is_resolved = FALSE
    ORDER BY score DESC, id ASC;
    `,
    [invoiceId]
  );

  const row = invRes.rows[0];
  return {
    invoiceId,
    riskScore: Number(row.risk_score || 0),
    riskLevel: row.risk_level || 'LOW',
    itcAtRisk: Number(row.itc_at_risk || 0),
    flags: flagsRes.rows,
  };
}
