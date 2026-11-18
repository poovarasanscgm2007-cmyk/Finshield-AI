import { GoogleGenAI, Type } from '@google/genai';
import { UserRole } from '../auth/permissions.ts';
import { env } from '../config/env.ts';
import { query } from '../db/pool.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { writeAuditLog } from './auditService.ts';

export interface CopilotEvidenceItem {
  recordType: string;
  recordId: string;
  label: string;
  link: string;
  summary: string;
}

export interface CopilotRecommendedAction {
  department: string;
  action: string;
  link: string;
}

export interface CopilotResponse {
  question: string;
  intent: string;
  source: 'LLM' | 'TEMPLATE_FALLBACK';
  answer: string;
  evidence: CopilotEvidenceItem[];
  recommendedActions: CopilotRecommendedAction[];
  rbacFiltered: boolean;
}

function isUsableApiKey(key: string): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  return trimmed.length > 10 && !trimmed.startsWith('MY_') && !trimmed.includes('YOUR_API_KEY');
}

function detectIntentAndEntities(question: string): {
  intent:
    | 'WHY_FLAGGED'
    | 'HIGH_RISK_LIST'
    | 'ITC_AT_RISK'
    | 'ASSIGNMENTS'
    | 'DEPARTMENT_TASKS'
    | 'GENERAL';
  invoiceNumberHint: string | null;
  poNumberHint: string | null;
  supplierHint: string | null;
  departmentHint: string | null;
} {
  const q = question.toLowerCase();

  const invMatch = question.match(/\b(INV[-_\s]?\d+)\b/i);
  const poMatch = question.match(/\b(PO[-_\s]?\d+)\b/i);

  let supplierHint: string | null = null;
  if (/\bsupplier\s*a\b|\bsup-a\b/i.test(question)) supplierHint = 'SUP-A';
  else if (/\bsupplier\s*b\b|\bsup-b\b/i.test(question)) supplierHint = 'SUP-B';

  let departmentHint: string | null = null;
  if (q.includes('warehouse')) departmentHint = 'WAREHOUSE';
  else if (q.includes('procurement')) departmentHint = 'PROCUREMENT';
  else if (q.includes('compliance')) departmentHint = 'COMPLIANCE';
  else if (q.includes('finance')) departmentHint = 'FINANCE';
  else if (/\bap\b|accounts payable/.test(q)) departmentHint = 'AP';

  let intent:
    | 'WHY_FLAGGED'
    | 'HIGH_RISK_LIST'
    | 'ITC_AT_RISK'
    | 'ASSIGNMENTS'
    | 'DEPARTMENT_TASKS'
    | 'GENERAL' = 'GENERAL';

  if (q.includes('assigned') || q.includes('who is')) {
    intent = 'ASSIGNMENTS';
  } else if (q.includes('itc') || q.includes('gstr-2b') || q.includes('gstr2b')) {
    intent = 'ITC_AT_RISK';
  } else if (q.includes('high risk') || q.includes('which invoices')) {
    intent = 'HIGH_RISK_LIST';
  } else if (departmentHint && (q.includes('verify') || q.includes('should') || q.includes('do'))) {
    intent = 'DEPARTMENT_TASKS';
  } else if (
    q.includes('why') ||
    q.includes('flag') ||
    q.includes('fail') ||
    invMatch ||
    poMatch ||
    supplierHint
  ) {
    intent = 'WHY_FLAGGED';
  }

  return {
    intent,
    invoiceNumberHint: invMatch ? invMatch[1].toUpperCase().replace(/\s+/g, '-') : null,
    poNumberHint: poMatch ? poMatch[1].toUpperCase().replace(/\s+/g, '-') : null,
    supplierHint,
    departmentHint,
  };
}

interface FetchedDatabaseFacts {
  rbacRestrictedNote: string | null;
  targetInvoice: {
    id: number;
    invoiceNumber: string;
    status: string;
    riskScore: number;
    riskLevel: string;
    itcAtRisk: number;
    subtotal: number;
    total: number;
    supplierId: number | null;
    supplierCode: string | null;
    supplierName: string | null;
    gstFilingStatus: string | null;
    poId: number | null;
    poNumber: string | null;
  } | null;
  latestMatch: {
    id: number;
    status: string;
    reasons: string[];
    poOrderedQty: number | null;
    grnReceivedQty: number | null;
    invoiceQty: number | null;
    poApprovedUnitPrice: number | null;
    invoiceUnitPrice: number | null;
  } | null;
  poChanges: Array<{
    id: number;
    poNumber: string;
    field: string;
    oldValue: string;
    newValue: string;
    status: string;
    changedByName: string;
  }>;
  historicalExtraCharges: Array<{
    invoiceId: number;
    invoiceNumber: string;
    extraCharges: number;
  }>;
  sharedBankSuppliers: Array<{
    id: number;
    supplierCode: string;
    name: string;
    bankIdentifier: string;
  }>;
  riskFlags: Array<{
    id: number;
    ruleCode: string;
    severity: string;
    reason: string;
    score: number;
  }>;
  investigations: Array<{
    id: number;
    invoiceId: number | null;
    invoiceNumber: string | null;
    issueType: string;
    department: string;
    status: string;
    severity: string;
    assignedToName: string | null;
    assignedToRole: string | null;
    description: string | null;
  }>;
  highRiskInvoices: Array<{
    id: number;
    invoiceNumber: string;
    supplierName: string;
    riskScore: number;
    riskLevel: string;
    itcAtRisk: number;
    status: string;
  }>;
  totalItcAtRiskInr: number;
  itcBreakdown: Array<{
    invoiceId: number;
    invoiceNumber: string;
    supplierName: string;
    itcAtRisk: number;
    gstFilingStatus: string | null;
  }>;
}

async function fetchGroundedFacts(params: {
  question: string;
  invoiceId?: number;
  actorRole: UserRole;
}): Promise<{
  intent: ReturnType<typeof detectIntentAndEntities>['intent'];
  departmentHint: string | null;
  facts: FetchedDatabaseFacts;
  evidence: CopilotEvidenceItem[];
  recommendedActions: CopilotRecommendedAction[];
}> {
  const detected = detectIntentAndEntities(params.question);
  const canReadAllRisk =
    params.actorRole === 'FINANCE_MANAGER' ||
    params.actorRole === 'ADMIN' ||
    params.actorRole === 'AP_EMPLOYEE' ||
    params.actorRole === 'PROCUREMENT_EMPLOYEE';

  const isWarehouseOnly = params.actorRole === 'WAREHOUSE_EMPLOYEE';

  // Resolve target invoice if requested by ID, invoice number, PO number, or supplier hint
  let targetInvoiceId: number | null = params.invoiceId ?? null;
  if (!targetInvoiceId && detected.invoiceNumberHint) {
    const norm = detected.invoiceNumberHint.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const res = await query<{ id: number }>(
      `
      SELECT id
      FROM invoices
      WHERE UPPER(invoice_number) = $1 OR normalized_invoice_number = $2
      ORDER BY is_historical ASC, id ASC
      LIMIT 1;
      `,
      [detected.invoiceNumberHint, norm]
    );
    targetInvoiceId = res.rows[0]?.id ?? null;
  }

  if (!targetInvoiceId && detected.poNumberHint) {
    const res = await query<{ id: number }>(
      `
      SELECT i.id
      FROM invoices i
      JOIN purchase_orders po ON po.id = i.po_id
      WHERE UPPER(po.po_number) = $1
      ORDER BY i.is_historical ASC, i.id ASC
      LIMIT 1;
      `,
      [detected.poNumberHint]
    );
    targetInvoiceId = res.rows[0]?.id ?? null;
  }

  if (!targetInvoiceId && detected.supplierHint) {
    const res = await query<{ id: number }>(
      `
      SELECT i.id
      FROM invoices i
      JOIN suppliers s ON s.id = i.supplier_id
      WHERE UPPER(s.supplier_code) = $1
      ORDER BY i.is_historical ASC, i.id ASC
      LIMIT 1;
      `,
      [detected.supplierHint]
    );
    targetInvoiceId = res.rows[0]?.id ?? null;
  }

  // Default to primary active flagged invoice (INV-101) when asking WHY_FLAGGED / ASSIGNMENTS without explicit ID
  if (
    !targetInvoiceId &&
    (detected.intent === 'WHY_FLAGGED' || detected.intent === 'ASSIGNMENTS')
  ) {
    const res = await query<{ id: number }>(
      `
      SELECT id
      FROM invoices
      WHERE is_historical = FALSE
      ORDER BY risk_score DESC, id ASC
      LIMIT 1;
      `
    );
    targetInvoiceId = res.rows[0]?.id ?? null;
  }

  const evidence: CopilotEvidenceItem[] = [];
  const recommendedActions: CopilotRecommendedAction[] = [];

  let targetInvoice: FetchedDatabaseFacts['targetInvoice'] = null;
  let latestMatch: FetchedDatabaseFacts['latestMatch'] = null;
  let poChanges: FetchedDatabaseFacts['poChanges'] = [];
  let historicalExtraCharges: FetchedDatabaseFacts['historicalExtraCharges'] = [];
  let sharedBankSuppliers: FetchedDatabaseFacts['sharedBankSuppliers'] = [];
  let riskFlags: FetchedDatabaseFacts['riskFlags'] = [];

  if (targetInvoiceId) {
    const invRes = await query<{
      id: number;
      invoice_number: string | null;
      status: string;
      risk_score: string;
      risk_level: string;
      itc_at_risk: string;
      subtotal: string | null;
      total: string | null;
      supplier_id: number | null;
      supplier_code: string | null;
      supplier_name: string | null;
      bank_identifier: string | null;
      gst_filing_status: string | null;
      po_id: number | null;
      po_number: string | null;
    }>(
      `
      SELECT
        i.id, i.invoice_number, i.status, i.risk_score, i.risk_level, i.itc_at_risk,
        i.subtotal, i.total, i.supplier_id,
        s.supplier_code, COALESCE(s.name, i.supplier_name_extracted) AS supplier_name,
        s.bank_identifier, s.gst_filing_status,
        i.po_id, po.po_number
      FROM invoices i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN purchase_orders po ON po.id = i.po_id
      WHERE i.id = $1
      LIMIT 1;
      `,
      [targetInvoiceId]
    );

    const invRow = invRes.rows[0];
    if (invRow) {
      targetInvoice = {
        id: invRow.id,
        invoiceNumber: invRow.invoice_number || `#${invRow.id}`,
        status: invRow.status,
        riskScore: Number(invRow.risk_score || 0),
        riskLevel: invRow.risk_level || 'LOW',
        itcAtRisk: isWarehouseOnly ? 0 : Number(invRow.itc_at_risk || 0),
        subtotal: Number(invRow.subtotal || 0),
        total: Number(invRow.total || 0),
        supplierId: invRow.supplier_id,
        supplierCode: invRow.supplier_code,
        supplierName: invRow.supplier_name,
        gstFilingStatus: invRow.gst_filing_status,
        poId: invRow.po_id,
        poNumber: invRow.po_number,
      };

      evidence.push({
        recordType: 'invoice',
        recordId: String(invRow.id),
        label: `Invoice ${targetInvoice.invoiceNumber}`,
        link: `/invoices/${invRow.id}`,
        summary: `Status: ${invRow.status}, Investigation priority: ${invRow.risk_level} (${invRow.risk_score}/100)`,
      });

      // Match results
      const mrRes = await query<{
        id: number;
        status: string;
        reasons: string[];
        compared_values: {
          poOrderedQty?: number;
          grnReceivedQty?: number;
          invoiceQty?: number;
          poApprovedUnitPrice?: number;
          invoiceUnitPrice?: number;
        };
      }>(
        `
        SELECT id, status, reasons, compared_values
        FROM match_results
        WHERE invoice_id = $1
        ORDER BY evaluated_at DESC, id DESC
        LIMIT 1;
        `,
        [targetInvoiceId]
      );
      if (mrRes.rows[0]) {
        const mr = mrRes.rows[0];
        latestMatch = {
          id: mr.id,
          status: mr.status,
          reasons: mr.reasons || [],
          poOrderedQty: mr.compared_values?.poOrderedQty ?? null,
          grnReceivedQty: mr.compared_values?.grnReceivedQty ?? null,
          invoiceQty: mr.compared_values?.invoiceQty ?? null,
          poApprovedUnitPrice: mr.compared_values?.poApprovedUnitPrice ?? null,
          invoiceUnitPrice: mr.compared_values?.invoiceUnitPrice ?? null,
        };
        evidence.push({
          recordType: 'match_result',
          recordId: String(mr.id),
          label: `3-Way Match #${mr.id} (${mr.status})`,
          link: `/invoices/${invRow.id}`,
          summary: (mr.reasons || []).slice(0, 2).join('; '),
        });
      }

      // PO Change history (non-Warehouse financial detail respecting RBAC)
      if (canReadAllRisk && invRow.po_id) {
        const pchRes = await query<{
          id: number;
          po_number: string;
          field: string;
          old_value: string;
          new_value: string;
          status: string;
          changed_by_name: string;
        }>(
          `
          SELECT pch.id, po.po_number, pch.field, pch.old_value, pch.new_value, pch.status, u.name AS changed_by_name
          FROM po_change_history pch
          JOIN purchase_orders po ON po.id = pch.po_id
          JOIN users u ON u.id = pch.changed_by
          WHERE pch.po_id = $1
          ORDER BY pch.changed_at DESC, pch.id DESC;
          `,
          [invRow.po_id]
        );
        poChanges = pchRes.rows.map((c) => ({
          id: c.id,
          poNumber: c.po_number,
          field: c.field,
          oldValue: c.old_value,
          newValue: c.new_value,
          status: c.status,
          changedByName: c.changed_by_name,
        }));
        for (const c of poChanges) {
          evidence.push({
            recordType: 'po_change_history',
            recordId: String(c.id),
            label: `${c.poNumber} Change #${c.id} (${c.status})`,
            link: '/approvals',
            summary: `${c.field} ${c.oldValue} -> ${c.newValue} by ${c.changedByName}`,
          });
        }
      }

      // Historical extra charges for supplier (non-Warehouse RBAC)
      if (canReadAllRisk && invRow.supplier_id) {
        const histRes = await query<{
          id: number;
          invoice_number: string;
          extra_charges: string;
        }>(
          `
          SELECT id, invoice_number, extra_charges
          FROM invoices
          WHERE supplier_id = $1 AND id <> $2 AND COALESCE(extra_charges, 0) > 0
          ORDER BY invoice_date DESC, id DESC;
          `,
          [invRow.supplier_id, targetInvoiceId]
        );
        historicalExtraCharges = histRes.rows.map((h) => ({
          invoiceId: h.id,
          invoiceNumber: h.invoice_number,
          extraCharges: Number(h.extra_charges),
        }));
        if (historicalExtraCharges.length > 0) {
          const uniqueAmts = Array.from(
            new Set(historicalExtraCharges.map((h) => h.extraCharges))
          ).sort((a, b) => a - b);
          evidence.push({
            recordType: 'historical_invoices',
            recordId: historicalExtraCharges.map((h) => h.invoiceId).join(','),
            label: `${historicalExtraCharges.length} Historical Extra-Charge Invoices`,
            link: `/invoices/${invRow.id}`,
            summary: `Repeated extra charges (${uniqueAmts.map((a) => `Rs ${a}`).join(', ')})`,
          });
        }

        // Shared bank identifier check
        if (invRow.bank_identifier) {
          const sharedRes = await query<{
            id: number;
            supplier_code: string;
            name: string;
            bank_identifier: string;
          }>(
            `
            SELECT id, supplier_code, name, bank_identifier
            FROM suppliers
            WHERE bank_identifier = $1
            ORDER BY id ASC;
            `,
            [invRow.bank_identifier]
          );
          if (sharedRes.rows.length > 1) {
            sharedBankSuppliers = sharedRes.rows.map((s) => ({
              id: s.id,
              supplierCode: s.supplier_code,
              name: s.name,
              bankIdentifier: s.bank_identifier,
            }));
            evidence.push({
              recordType: 'suppliers',
              recordId: sharedBankSuppliers.map((s) => s.id).join(','),
              label: `Shared Bank ID (${invRow.bank_identifier})`,
              link: `/invoices/${invRow.id}`,
              summary: sharedBankSuppliers.map((s) => `${s.name} [${s.supplierCode}]`).join(' & '),
            });
          }
        }
      }

      // Active risk flags on invoice (filtered for Warehouse RBAC)
      const rfRes = await query<{
        id: number;
        rule_code: string;
        severity: string;
        reason: string;
        score: string;
      }>(
        `
        SELECT id, rule_code, severity, reason, score
        FROM risk_flags
        WHERE entity_type = 'invoice'
          AND entity_id = $1
          AND is_resolved = FALSE
        ORDER BY score DESC, id ASC;
        `,
        [targetInvoiceId]
      );
      riskFlags = rfRes.rows
        .filter((f) => !isWarehouseOnly || f.rule_code === 'QTY_MISMATCH')
        .map((f) => ({
          id: f.id,
          ruleCode: f.rule_code,
          severity: f.severity,
          reason: f.reason,
          score: Number(f.score),
        }));

      for (const f of riskFlags) {
        evidence.push({
          recordType: 'risk_flag',
          recordId: String(f.id),
          label: `${f.ruleCode} (#${f.id})`,
          link: `/invoices/${invRow.id}`,
          summary: f.reason,
        });
      }
    }
  }

  // Investigations (RBAC: Warehouse sees Warehouse/assigned investigations; others see permitted or all)
  const invWhereParts: string[] = [];
  const invParams: unknown[] = [];
  if (targetInvoiceId) {
    invParams.push(targetInvoiceId);
    invWhereParts.push(`inv.invoice_id = $${invParams.length}`);
  }
  if (detected.departmentHint) {
    invParams.push(`%${detected.departmentHint}%`);
    invWhereParts.push(`UPPER(inv.department) LIKE $${invParams.length}`);
  }
  if (isWarehouseOnly) {
    invWhereParts.push(`UPPER(inv.department) LIKE '%WAREHOUSE%'`);
  }

  const invWhere = invWhereParts.length > 0 ? `WHERE ${invWhereParts.join(' AND ')}` : '';
  const invListRes = await query<{
    id: number;
    invoice_id: number | null;
    invoice_number: string | null;
    issue_type: string;
    department: string;
    status: string;
    severity: string;
    assigned_to_name: string | null;
    assigned_to_role: string | null;
    description: string | null;
  }>(
    `
    SELECT
      inv.id, inv.invoice_id, i.invoice_number, inv.issue_type, inv.department,
      inv.status, inv.severity, u.name AS assigned_to_name, u.role AS assigned_to_role, inv.description
    FROM investigations inv
    LEFT JOIN invoices i ON i.id = inv.invoice_id
    LEFT JOIN users u ON u.id = inv.assigned_to
    ${invWhere}
    ORDER BY inv.id ASC
    LIMIT 25;
    `,
    invParams
  );

  const investigations = invListRes.rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    issueType: r.issue_type,
    department: r.department,
    status: r.status,
    severity: r.severity,
    assignedToName: r.assigned_to_name,
    assignedToRole: r.assigned_to_role,
    description: r.description,
  }));

  for (const invItem of investigations) {
    evidence.push({
      recordType: 'investigation',
      recordId: String(invItem.id),
      label: `Investigation #${invItem.id} · ${invItem.issueType}`,
      link: `/investigations?id=${invItem.id}`,
      summary: `${invItem.department} (${invItem.status}) assigned to ${invItem.assignedToName || 'Unassigned'}`,
    });

    if (invItem.status !== 'REVALIDATED') {
      recommendedActions.push({
        department: invItem.department,
        action:
          invItem.issueType === 'QUANTITY_MISMATCH'
            ? `Verify physical delivery / record corrected GRN for ${invItem.invoiceNumber || `Invoice #${invItem.invoiceId}`} and resolve Investigation #${invItem.id}.`
            : `Review and resolve ${invItem.issueType} (Investigation #${invItem.id}): ${invItem.description || ''}`,
        link: `/investigations?id=${invItem.id}`,
      });
    }
  }

  // High-risk invoices list & ITC summary (RBAC protected for non-Warehouse roles)
  let highRiskInvoices: FetchedDatabaseFacts['highRiskInvoices'] = [];
  let totalItcAtRiskInr = 0;
  let itcBreakdown: FetchedDatabaseFacts['itcBreakdown'] = [];
  let rbacRestrictedNote: string | null = null;

  if (canReadAllRisk) {
    const hrRes = await query<{
      id: number;
      invoice_number: string | null;
      supplier_name: string | null;
      risk_score: string;
      risk_level: string;
      itc_at_risk: string;
      status: string;
    }>(
      `
      SELECT
        i.id, i.invoice_number, COALESCE(s.name, i.supplier_name_extracted) AS supplier_name,
        i.risk_score, i.risk_level, i.itc_at_risk, i.status
      FROM invoices i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.risk_level IN ('HIGH', 'CRITICAL')
      ORDER BY i.risk_score DESC, i.id ASC;
      `
    );
    highRiskInvoices = hrRes.rows.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoice_number || `#${r.id}`,
      supplierName: r.supplier_name || 'Unknown',
      riskScore: Number(r.risk_score),
      riskLevel: r.risk_level,
      itcAtRisk: Number(r.itc_at_risk),
      status: r.status,
    }));

    if (detected.intent === 'HIGH_RISK_LIST') {
      for (const hr of highRiskInvoices) {
        evidence.push({
          recordType: 'invoice',
          recordId: String(hr.id),
          label: `${hr.invoiceNumber} (${hr.riskLevel})`,
          link: `/invoices/${hr.id}`,
          summary: `${hr.supplierName} · Investigation priority score ${hr.riskScore}/100 · ITC at risk Rs ${hr.itcAtRisk.toFixed(2)}`,
        });
      }
    }

    const itcRes = await query<{
      id: number;
      invoice_number: string | null;
      supplier_name: string | null;
      itc_at_risk: string;
      gst_filing_status: string | null;
    }>(
      `
      SELECT
        i.id, i.invoice_number, COALESCE(s.name, i.supplier_name_extracted) AS supplier_name,
        i.itc_at_risk, s.gst_filing_status
      FROM invoices i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.itc_at_risk > 0
      ORDER BY i.itc_at_risk DESC, i.id ASC;
      `
    );
    itcBreakdown = itcRes.rows.map((r) => ({
      invoiceId: r.id,
      invoiceNumber: r.invoice_number || `#${r.id}`,
      supplierName: r.supplier_name || 'Unknown',
      itcAtRisk: Number(r.itc_at_risk),
      gstFilingStatus: r.gst_filing_status,
    }));
    totalItcAtRiskInr = Number(
      itcBreakdown.reduce((sum, r) => sum + r.itcAtRisk, 0).toFixed(2)
    );

    if (detected.intent === 'ITC_AT_RISK') {
      for (const item of itcBreakdown) {
        evidence.push({
          recordType: 'invoice',
          recordId: String(item.invoiceId),
          label: `${item.invoiceNumber} ITC at Risk`,
          link: `/invoices/${item.invoiceId}`,
          summary: `Rs ${item.itcAtRisk.toFixed(2)} (${item.supplierName} · ${item.gstFilingStatus || 'UNKNOWN'})`,
        });
      }
    }
  } else {
    rbacRestrictedNote =
      'Role-based access control: Warehouse Employee view is scoped to GRN/quantity verification and Warehouse-assigned investigations; GST/ITC and supplier financial risk figures are restricted to AP, Procurement, Finance Manager, and Admin.';
  }

  // Deduplicate evidence chips
  const uniqueEvidence = new Map<string, CopilotEvidenceItem>();
  for (const e of evidence) {
    const key = `${e.recordType}:${e.recordId}`;
    if (!uniqueEvidence.has(key)) {
      uniqueEvidence.set(key, e);
    }
  }

  return {
    intent: detected.intent,
    departmentHint: detected.departmentHint,
    facts: {
      rbacRestrictedNote,
      targetInvoice,
      latestMatch,
      poChanges,
      historicalExtraCharges,
      sharedBankSuppliers,
      riskFlags,
      investigations,
      highRiskInvoices,
      totalItcAtRiskInr,
      itcBreakdown,
    },
    evidence: Array.from(uniqueEvidence.values()),
    recommendedActions: recommendedActions.slice(0, 6),
  };
}

function buildTemplateAnswer(params: {
  question: string;
  intent: string;
  departmentHint: string | null;
  facts: FetchedDatabaseFacts;
}): string {
  const { intent, facts } = params;

  if (facts.rbacRestrictedNote && (intent === 'ITC_AT_RISK' || intent === 'HIGH_RISK_LIST')) {
    return facts.rbacRestrictedNote;
  }

  if (intent === 'ITC_AT_RISK') {
    if (facts.itcBreakdown.length === 0) {
      return 'No invoices currently have Input Tax Credit (ITC) at risk in the database (Total ITC at risk: Rs 0.00).';
    }
    const lines = facts.itcBreakdown.map(
      (i) =>
        `- Invoice #${i.invoiceId} (${i.invoiceNumber}, ${i.supplierName}): Rs ${i.itcAtRisk.toFixed(
          2
        )} at risk (Filing status: ${i.gstFilingStatus || 'N/A'})`
    );
    return `Total ITC currently at risk across active invoices is Rs ${facts.totalItcAtRiskInr.toFixed(
      2
    )}:\n${lines.join('\n')}`;
  }

  if (intent === 'HIGH_RISK_LIST') {
    if (facts.highRiskInvoices.length === 0) {
      return 'There are currently no invoices classified as HIGH or CRITICAL investigation priority in the database.';
    }
    const lines = facts.highRiskInvoices.map(
      (i) =>
        `- Invoice #${i.id} (${i.invoiceNumber}) from ${i.supplierName}: Investigation priority ${i.riskLevel} (score ${i.riskScore}/100), Status ${i.status}, ITC at risk Rs ${i.itcAtRisk.toFixed(
          2
        )}`
    );
    return `Found ${facts.highRiskInvoices.length} high-priority invoice(s) requiring investigation (note: risk score indicates investigation priority, not proof of fraud):\n${lines.join(
      '\n'
    )}`;
  }

  if (intent === 'ASSIGNMENTS') {
    if (facts.investigations.length === 0) {
      return 'No open or historical investigations were found matching that query in the database.';
    }
    const lines = facts.investigations.map(
      (inv) =>
        `- Investigation #${inv.id} (${inv.issueType} on ${inv.invoiceNumber || `Invoice #${inv.invoiceId}`}): Department ${inv.department}, assigned to ${
          inv.assignedToName || 'Unassigned'
        } (${inv.assignedToRole || 'N/A'}), status ${inv.status}`
    );
    return `Investigation assignments found:\n${lines.join('\n')}`;
  }

  if (intent === 'DEPARTMENT_TASKS') {
    if (facts.investigations.length === 0) {
      return `No investigations found for department ${params.departmentHint || 'specified'} in the database.`;
    }
    const openOnly = facts.investigations.filter((i) => i.status !== 'REVALIDATED');
    const items = openOnly.length > 0 ? openOnly : facts.investigations;
    const lines = items.map(
      (inv) =>
        `- Investigation #${inv.id} (${inv.issueType} on ${inv.invoiceNumber || `Invoice #${inv.invoiceId}`} · ${inv.status}): ${
          inv.description || 'Review evidence and resolve.'
        } (Assigned: ${inv.assignedToName || 'Unassigned'})`
    );
    return `${params.departmentHint || 'Department'} verification checklist based on database records:\n${lines.join(
      '\n'
    )}`;
  }

  // WHY_FLAGGED or GENERAL with targetInvoice
  if (facts.targetInvoice) {
    const inv = facts.targetInvoice;
    const parts: string[] = [];
    parts.push(
      `Invoice ${inv.invoiceNumber} (record #${inv.id}, ${inv.supplierName || 'Unknown supplier'}) is currently ${inv.status} with investigation priority ${inv.riskLevel} (${inv.riskScore}/100):`
    );

    if (facts.latestMatch && facts.latestMatch.reasons.length > 0) {
      parts.push(
        `- 3-Way Matching (${facts.latestMatch.status}, Match #${facts.latestMatch.id}): ${facts.latestMatch.reasons.join(
          '; '
        )}.`
      );
    }

    if (facts.poChanges.length > 0) {
      for (const ch of facts.poChanges) {
        parts.push(
          `- PO Change Monitoring (${ch.poNumber} Change #${ch.id}): ${ch.field} changed from Rs ${ch.oldValue} to Rs ${ch.newValue} by ${ch.changedByName} (${ch.status}).`
        );
      }
    }

    if (facts.historicalExtraCharges.length > 0) {
      const uniqueAmts = Array.from(
        new Set(facts.historicalExtraCharges.map((h) => h.extraCharges))
      ).sort((a, b) => a - b);
      parts.push(
        `- Repeated Extra Charges: ${facts.historicalExtraCharges.length} historical invoices carry extra charges (${uniqueAmts
          .map((a) => `Rs ${a}`)
          .join(', ')}).`
      );
    }

    if (inv.itcAtRisk > 0) {
      parts.push(
        `- GST / ITC Risk: Rs ${inv.itcAtRisk.toFixed(
          2
        )} ITC at risk (GSTR-2B verification missing / Supplier filing status: ${
          inv.gstFilingStatus || 'UNKNOWN'
        }).`
      );
    }

    if (facts.sharedBankSuppliers.length > 1) {
      parts.push(
        `- Supplier Relationship Notice (verification indicator, not proof of fraud): Shares bank identifier ${
          facts.sharedBankSuppliers[0].bankIdentifier
        } across ${facts.sharedBankSuppliers.map((s) => s.name).join(' and ')}.`
      );
    }

    if (facts.riskFlags.length > 0 && parts.length <= 2) {
      for (const rf of facts.riskFlags) {
        parts.push(`- ${rf.ruleCode} (Flag #${rf.id}): ${rf.reason}`);
      }
    }

    if (facts.investigations.length > 0) {
      parts.push(
        `Active investigations (${facts.investigations.length}): ` +
          facts.investigations
            .map(
              (iv) =>
                `#${iv.id} ${iv.issueType} -> ${iv.department} (${iv.status}, assigned to ${
                  iv.assignedToName || 'Unassigned'
                })`
            )
            .join('; ') +
          '.'
      );
    }

    if (facts.rbacRestrictedNote) {
      parts.push(facts.rbacRestrictedNote);
    }

    return parts.join('\n');
  }

  return 'No matching invoice, PO, or investigation records were found for that query. Specify an invoice number (e.g., INV-101) or ask about high-risk invoices, ITC at risk, or department tasks.';
}

async function synthesizeWithGemini(params: {
  question: string;
  facts: FetchedDatabaseFacts;
  evidence: CopilotEvidenceItem[];
}): Promise<string | null> {
  const ai = new GoogleGenAI({
    apiKey: env.LLM_API_KEY,
    httpOptions: {
      timeout: 12000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: `USER QUESTION: ${params.question}

VERIFIED DATABASE FACTS (JSON):
${JSON.stringify(params.facts, null, 2)}

AVAILABLE EVIDENCE RECORDS:
${JSON.stringify(
  params.evidence.map((e) => ({ type: e.recordType, id: e.recordId, label: e.label, summary: e.summary })),
  null,
  2
)}`,
    config: {
      systemInstruction:
        'You are the FINSHIELD AI Audit Copilot. Answer strictly and exclusively from the VERIFIED DATABASE FACTS JSON provided. Use clear, plain business language and enumerate EVERY active issue found in the JSON with exact numbers and record IDs: (1) 3-way quantity mismatch & gap (e.g. received vs invoiced and gap like 20 kg), (2) PO price changes (e.g. Rs 500 to Rs 700, status UNAPPROVED), (3) historical extra charges (list all unique amounts e.g. Rs 500, Rs 700, Rs 1000), (4) GST/GSTR-2B ITC at risk in INR (e.g. Rs 9,000), (5) duplicate flags or shared bank IDs, and (6) open investigations with assigned department & assignee. Remind that risk scores reflect investigation priority rather than proof of fraud, never invent any missing data, and mention RBAC restrictions if rbacRestrictedNote is present.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          answer: {
            type: Type.STRING,
            description: 'Concise factual answer grounded strictly in the provided database facts with record IDs.',
          },
        },
        required: ['answer'],
      },
    },
  });

  const text = (response.text || '').trim();
  if (!text) return null;
  const parsed = JSON.parse(text) as { answer?: string };
  return parsed.answer?.trim() || null;
}

export async function askCopilot(params: {
  question: string;
  invoiceId?: number;
  actorId: number;
  actorRole: UserRole;
}): Promise<CopilotResponse> {
  const cleanQuestion = (params.question || '').trim();
  if (!cleanQuestion) {
    throw new HttpError(400, 'A question is required.');
  }

  const grounded = await fetchGroundedFacts({
    question: cleanQuestion,
    invoiceId: params.invoiceId,
    actorRole: params.actorRole,
  });

  let answer: string | null = null;
  let source: 'LLM' | 'TEMPLATE_FALLBACK' = 'TEMPLATE_FALLBACK';

  if (isUsableApiKey(env.LLM_API_KEY)) {
    try {
      const llmAnswer = await synthesizeWithGemini({
        question: cleanQuestion,
        facts: grounded.facts,
        evidence: grounded.evidence,
      });
      if (llmAnswer) {
        answer = llmAnswer;
        source = 'LLM';
      }
    } catch (err) {
      console.warn(
        'Copilot LLM synthesis failed, using template fallback:',
        err instanceof Error ? err.message : err
      );
    }
  }

  if (!answer) {
    answer = buildTemplateAnswer({
      question: cleanQuestion,
      intent: grounded.intent,
      departmentHint: grounded.departmentHint,
      facts: grounded.facts,
    });
    source = 'TEMPLATE_FALLBACK';
  }

  await writeAuditLog(
    params.actorId,
    'COPILOT_QUERY',
    'copilot',
    params.invoiceId ? String(params.invoiceId) : 'global',
    {
      question: cleanQuestion,
      intent: grounded.intent,
      source,
      actorRole: params.actorRole,
      evidenceCount: grounded.evidence.length,
      answerPreview: answer.slice(0, 500),
    }
  );

  return {
    question: cleanQuestion,
    intent: grounded.intent,
    source,
    answer,
    evidence: grounded.evidence,
    recommendedActions: grounded.recommendedActions,
    rbacFiltered: Boolean(grounded.facts.rbacRestrictedNote),
  };
}
