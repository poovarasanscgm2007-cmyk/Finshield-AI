import { PoolClient } from 'pg';
import { UserRole } from '../auth/permissions.ts';
import { getPool, query } from '../db/pool.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { writeAuditLog } from './auditService.ts';

export type SupplierEdgeType =
  | 'SHARED_BANK'
  | 'SHARED_ADDRESS'
  | 'SHARED_PHONE'
  | 'SHARED_PAN_PATTERN';

export interface SupplierGraphNode {
  id: number;
  supplierCode: string;
  name: string;
  gstin: string;
  pan: string;
  stateCode: string;
  maskedBankIdentifier: string;
  address: string;
  phone: string;
  gstFilingStatus: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskScore: number;
  activeInvoiceCount: number;
  openInvestigationsCount: number;
  isSampleData: boolean;
}

export interface SupplierGraphEdge {
  id: string;
  source: number;
  target: number;
  type: SupplierEdgeType;
  sharedValue: string;
  reason: string;
  requiresVerification: true;
  linkedInvestigations: Array<{
    id: number;
    issueType: string;
    department: string;
    status: string;
    severity: string;
    assignedToName: string | null;
  }>;
}

export interface SupplierScorecardMetric {
  key: string;
  label: string;
  score: number;
  weight: number;
  weightedContribution: number;
  formula: string;
  inputs: Record<string, unknown>;
  unit: string;
}

export interface SupplierScorecard {
  supplierId: number;
  supplierCode: string;
  name: string;
  gstin: string;
  pan: string;
  stateCode: string;
  gstFilingStatus: string;
  maskedBankIdentifier: string;
  overallScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  label: string;
  disclaimer: string;
  metrics: SupplierScorecardMetric[];
  summary: {
    totalInvoices: number;
    matchedInvoices: number;
    poOrderedQty: number;
    grnReceivedQty: number;
    repeatedExtraChargeInvoices: number;
    discrepantInvoices: number;
    openInvestigations: number;
    resolvedInvestigations: number;
    avgResolutionHours: number;
    gstr2bMissingCount: number;
  };
  linkedInvoices: Array<{
    id: number;
    invoiceNumber: string;
    invoiceDate: string | null;
    total: number;
    status: string;
    riskLevel: string;
    riskScore: number;
    extraCharges: number;
    isHistorical: boolean;
  }>;
  linkedInvestigations: Array<{
    id: number;
    invoiceId: number | null;
    invoiceNumber: string | null;
    issueType: string;
    department: string;
    status: string;
    severity: string;
    description: string | null;
  }>;
  pendingBankChanges: Array<{
    approvalId: number;
    oldBankMasked: string;
    newBankMasked: string;
    requestedByName: string;
    status: string;
    createdAt: string;
  }>;
  isSampleData: boolean;
}

interface SupplierRow {
  id: number;
  supplier_code: string;
  name: string;
  gstin: string;
  pan: string;
  state_code: string;
  bank_identifier: string;
  address: string;
  phone: string;
  gst_filing_status: string;
  is_sample_data: boolean;
}

export function maskBankIdentifier(raw: string | null | undefined): string {
  const clean = (raw || '').trim();
  if (!clean) return 'XXXX0000';
  const withoutSample = clean.replace(/[-_\s]*SAMPLE$/i, '');
  const alnum = withoutSample.replace(/[^A-Za-z0-9]/g, '');
  const tail = alnum.slice(-4) || clean.slice(-4);
  return `XXXX${tail.toUpperCase()}`;
}

function normalizeText(raw: string | null | undefined): string {
  return (raw || '')
    .toLowerCase()
    .replace(/\(sample[^)]*\)/gi, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizePhone(raw: string | null | undefined): string {
  const digits = (raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

async function pickComplianceAssignee(client: PoolClient): Promise<number | null> {
  const usersRes = await client.query<{ id: number }>(
    `
    SELECT id
    FROM users
    WHERE is_active = TRUE AND role = 'FINANCE_MANAGER'
    ORDER BY id ASC;
    `
  );
  if (usersRes.rows.length === 0) return null;
  const countRes = await client.query<{ cnt: string }>(
    "SELECT COUNT(*)::text AS cnt FROM investigations WHERE department = 'FINANCE & COMPLIANCE'"
  );
  const idx = Number(countRes.rows[0]?.cnt || 0) % usersRes.rows.length;
  return usersRes.rows[idx].id;
}

/**
 * Synchronizes SHARED_BANK risk flags and Finance & Compliance investigations
 * idempotently so no duplicate flags or investigations are ever created.
 */
export async function syncSupplierGraphRisks(externalClient?: PoolClient): Promise<void> {
  const pool = getPool();
  const ownsClient = !externalClient;
  const client = externalClient ?? (await pool.connect());

  try {
    if (ownsClient) {
      await client.query('BEGIN');
    }

    const supRes = await client.query<SupplierRow>(
      'SELECT * FROM suppliers ORDER BY id ASC'
    );
    const suppliers = supRes.rows;

    const bankGroups = new Map<string, SupplierRow[]>();
    for (const s of suppliers) {
      const bankKey = (s.bank_identifier || '').trim().toUpperCase();
      if (!bankKey) continue;
      const list = bankGroups.get(bankKey) ?? [];
      list.push(s);
      bankGroups.set(bankKey, list);
    }

    for (const [bankKey, group] of bankGroups.entries()) {
      if (group.length < 2) continue;
      const masked = maskBankIdentifier(bankKey);

      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          const edgeKey = `SHARED_BANK:${a.id}-${b.id}`;
          const reason = `${a.name} (${a.supplier_code}) and ${b.name} (${b.supplier_code}) share bank identifier ${masked}. Relationship requires verification — indicator only, not proof of fraud.`;

          // 1. Ensure supplier-level risk flags exist on both suppliers without duplicating
          for (const target of [a, b]) {
            const other = target.id === a.id ? b : a;
            const flagCheck = await client.query<{ id: number }>(
              `
              SELECT id
              FROM risk_flags
              WHERE entity_type = 'supplier'
                AND entity_id = $1
                AND rule_code = 'SHARED_BANK_IDENTIFIER'
                AND is_resolved = FALSE
              LIMIT 1;
              `,
              [target.id]
            );
            if (flagCheck.rowCount === 0) {
              await client.query(
                `
                INSERT INTO risk_flags (
                  entity_type, entity_id, rule_code, severity, reason, score, metadata, is_resolved, is_sample_data
                )
                VALUES ('supplier', $1, 'SHARED_BANK_IDENTIFIER', 'MEDIUM', $2, 15.00, $3::jsonb, FALSE, TRUE);
                `,
                [
                  target.id,
                  `${target.name} shares bank identifier ${masked} with ${other.name} (${other.supplier_code}). Relationship requires verification.`,
                  JSON.stringify({
                    edgeKey,
                    maskedBankIdentifier: masked,
                    linkedSupplierId: other.id,
                    linkedSupplierCode: other.supplier_code,
                  }),
                ]
              );
            }
          }

          // 2. Ensure a Finance & Compliance investigation exists for this SHARED_BANK edge without duplicating
          const invCheck = await client.query<{ id: number }>(
            `
            SELECT id
            FROM investigations
            WHERE issue_type = 'SUPPLIER_RISK'
              AND (
                evidence->>'edgeKey' = $1
                OR supplier_id IN ($2, $3)
              )
              AND status <> 'CLOSED'
            LIMIT 1;
            `,
            [edgeKey, a.id, b.id]
          );

          if (invCheck.rowCount === 0) {
            const assigneeId = await pickComplianceAssignee(client);
            const inserted = await client.query<{ id: number }>(
              `
              INSERT INTO investigations (
                invoice_id, supplier_id, issue_type, department, allowed_departments,
                assigned_to, status, severity, title, description, evidence, is_sample_data
              )
              VALUES (
                NULL, $1, 'SUPPLIER_RISK', 'FINANCE & COMPLIANCE', '["FINANCE","COMPLIANCE"]'::jsonb,
                $2, 'OPEN', 'MEDIUM', $3, $4, $5::jsonb, TRUE
              )
              RETURNING id;
              `,
              [
                a.id,
                assigneeId,
                `Shared Bank Verification (${a.supplier_code} & ${b.supplier_code})`,
                reason,
                JSON.stringify({
                  edgeKey,
                  edgeType: 'SHARED_BANK',
                  maskedBankIdentifier: masked,
                  supplierIds: [a.id, b.id],
                  supplierCodes: [a.supplier_code, b.supplier_code],
                  requiresVerification: true,
                }),
              ]
            );
            const newId = inserted.rows[0].id;
            await client.query(
              `
              INSERT INTO investigation_comments (investigation_id, author_id, comment, status_from, status_to, is_sample_data)
              VALUES ($1, NULL, $2, NULL, 'OPEN', TRUE);
              `,
              [newId, `Auto-created from supplier relationship graph: ${reason}`]
            );
            await writeAuditLog(
              null,
              'SUPPLIER_GRAPH_INVESTIGATION_CREATED',
              'investigations',
              newId,
              {
                edgeKey,
                edgeType: 'SHARED_BANK',
                maskedBankIdentifier: masked,
                supplierIds: [a.id, b.id],
              },
              client
            );
          }
        }
      }
    }

    if (ownsClient) {
      await client.query('COMMIT');
    }
  } catch (err) {
    if (ownsClient) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw err;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

export async function getSupplierRelationshipGraph(): Promise<{
  isSampleData: true;
  disclaimer: string;
  nodes: SupplierGraphNode[];
  edges: SupplierGraphEdge[];
}> {
  await syncSupplierGraphRisks();

  const [supRes, invStatsRes, invCasesRes] = await Promise.all([
    query<SupplierRow>('SELECT * FROM suppliers ORDER BY id ASC'),
    query<{
      supplier_id: number;
      active_invoice_count: string;
      max_risk_score: string;
      has_high_risk: boolean;
      has_medium_risk: boolean;
    }>(
      `
      SELECT
        supplier_id,
        COUNT(*) FILTER (WHERE is_historical = FALSE)::text AS active_invoice_count,
        COALESCE(MAX(risk_score), 0)::text AS max_risk_score,
        BOOL_OR(risk_level IN ('HIGH', 'CRITICAL')) AS has_high_risk,
        BOOL_OR(risk_level = 'MEDIUM') AS has_medium_risk
      FROM invoices
      GROUP BY supplier_id;
      `
    ),
    query<{
      id: number;
      supplier_id: number | null;
      issue_type: string;
      department: string;
      status: string;
      severity: string;
      evidence: Record<string, unknown>;
      assigned_to_name: string | null;
    }>(
      `
      SELECT
        inv.id,
        COALESCE(inv.supplier_id, i.supplier_id) AS supplier_id,
        inv.issue_type,
        inv.department,
        inv.status,
        inv.severity,
        inv.evidence,
        u.name AS assigned_to_name
      FROM investigations inv
      LEFT JOIN invoices i ON i.id = inv.invoice_id
      LEFT JOIN users u ON u.id = inv.assigned_to
      ORDER BY inv.id ASC;
      `
    ),
  ]);

  const statsBySup = new Map<
    number,
    { activeInvoiceCount: number; maxRiskScore: number; hasHigh: boolean; hasMedium: boolean }
  >();
  for (const r of invStatsRes.rows) {
    statsBySup.set(r.supplier_id, {
      activeInvoiceCount: Number(r.active_invoice_count || 0),
      maxRiskScore: Number(r.max_risk_score || 0),
      hasHigh: Boolean(r.has_high_risk),
      hasMedium: Boolean(r.has_medium_risk),
    });
  }

  const suppliers = supRes.rows;
  const edges: SupplierGraphEdge[] = [];

  for (let i = 0; i < suppliers.length; i++) {
    for (let j = i + 1; j < suppliers.length; j++) {
      const a = suppliers[i];
      const b = suppliers[j];

      const linkedForPair = invCasesRes.rows
        .filter((c) => {
          if (c.issue_type !== 'SUPPLIER_RISK' && c.issue_type !== 'GST_ITC_RISK') return false;
          const sid = c.supplier_id;
          const evIds = Array.isArray(c.evidence?.supplierIds)
            ? (c.evidence.supplierIds as number[])
            : [];
          return sid === a.id || sid === b.id || evIds.includes(a.id) || evIds.includes(b.id);
        })
        .map((c) => ({
          id: c.id,
          issueType: c.issue_type,
          department: c.department,
          status: c.status,
          severity: c.severity,
          assignedToName: c.assigned_to_name,
        }));

      const bankA = (a.bank_identifier || '').trim().toUpperCase();
      const bankB = (b.bank_identifier || '').trim().toUpperCase();
      if (bankA && bankA === bankB) {
        const masked = maskBankIdentifier(bankA);
        edges.push({
          id: `SHARED_BANK:${a.id}-${b.id}`,
          source: a.id,
          target: b.id,
          type: 'SHARED_BANK',
          sharedValue: masked,
          reason: `${a.name} and ${b.name} share bank identifier ${masked}. Relationship requires verification.`,
          requiresVerification: true,
          linkedInvestigations: linkedForPair,
        });
      }

      const addrA = normalizeText(a.address);
      const addrB = normalizeText(b.address);
      if (addrA && addrA === addrB) {
        edges.push({
          id: `SHARED_ADDRESS:${a.id}-${b.id}`,
          source: a.id,
          target: b.id,
          type: 'SHARED_ADDRESS',
          sharedValue: a.address,
          reason: `${a.name} and ${b.name} share physical address. Relationship requires verification.`,
          requiresVerification: true,
          linkedInvestigations: linkedForPair,
        });
      }

      const phoneA = normalizePhone(a.phone);
      const phoneB = normalizePhone(b.phone);
      if (phoneA && phoneA === phoneB) {
        edges.push({
          id: `SHARED_PHONE:${a.id}-${b.id}`,
          source: a.id,
          target: b.id,
          type: 'SHARED_PHONE',
          sharedValue: a.phone,
          reason: `${a.name} and ${b.name} share phone number ${a.phone}. Relationship requires verification.`,
          requiresVerification: true,
          linkedInvestigations: linkedForPair,
        });
      }

      const panA = (a.pan || a.gstin.slice(2, 12)).trim().toUpperCase();
      const panB = (b.pan || b.gstin.slice(2, 12)).trim().toUpperCase();
      if (panA && panB && panA === panB) {
        edges.push({
          id: `SHARED_PAN_PATTERN:${a.id}-${b.id}`,
          source: a.id,
          target: b.id,
          type: 'SHARED_PAN_PATTERN',
          sharedValue: `PAN ${panA}`,
          reason: `${a.name} and ${b.name} share GSTIN/PAN root ${panA}. Relationship requires verification.`,
          requiresVerification: true,
          linkedInvestigations: linkedForPair,
        });
      }
    }
  }

  const nodes: SupplierGraphNode[] = suppliers.map((s) => {
    const st = statsBySup.get(s.id);
    const hasSharedEdge = edges.some((e) => e.source === s.id || e.target === s.id);
    const openInvs = invCasesRes.rows.filter(
      (c) => c.supplier_id === s.id && c.status !== 'REVALIDATED' && c.status !== 'CLOSED'
    ).length;

    let riskLevel: SupplierGraphNode['riskLevel'] = 'LOW';
    if (st?.hasHigh) riskLevel = 'HIGH';
    else if (st?.hasMedium || hasSharedEdge || s.gst_filing_status !== 'REGULAR') riskLevel = 'MEDIUM';

    const riskScore = Math.max(st?.maxRiskScore ?? 0, hasSharedEdge ? 30 : 0);

    return {
      id: s.id,
      supplierCode: s.supplier_code,
      name: s.name,
      gstin: s.gstin,
      pan: s.pan,
      stateCode: s.state_code,
      maskedBankIdentifier: maskBankIdentifier(s.bank_identifier),
      address: s.address,
      phone: s.phone,
      gstFilingStatus: s.gst_filing_status,
      riskLevel,
      riskScore,
      activeInvoiceCount: st?.activeInvoiceCount ?? 0,
      openInvestigationsCount: openInvs,
      isSampleData: s.is_sample_data,
    };
  });

  return {
    isSampleData: true,
    disclaimer:
      'Shared attributes are indicators only — Relationship requires verification, never proof of fraud.',
    nodes,
    edges,
  };
}

export async function requestSupplierBankChange(params: {
  supplierId: number;
  newBankIdentifier: string;
  reason?: string;
  actorId: number;
  actorRole: UserRole;
}): Promise<{
  message: string;
  approval: Record<string, unknown>;
}> {
  const newBank = (params.newBankIdentifier || '').trim();
  if (newBank.length < 6) {
    throw new HttpError(400, 'newBankIdentifier must be at least 6 characters.');
  }

  const supRes = await query<SupplierRow>(
    'SELECT * FROM suppliers WHERE id = $1 LIMIT 1',
    [params.supplierId]
  );
  if (supRes.rowCount === 0) {
    throw new HttpError(404, `Supplier #${params.supplierId} not found.`);
  }
  const supplier = supRes.rows[0];

  if (supplier.bank_identifier.trim().toUpperCase() === newBank.toUpperCase()) {
    throw new HttpError(400, 'New bank identifier matches the existing bank identifier.');
  }

  const oldBankMasked = maskBankIdentifier(supplier.bank_identifier);
  const newBankMasked = maskBankIdentifier(newBank);
  const cleanReason =
    params.reason?.trim() || `Bank identifier update requested (${oldBankMasked} -> ${newBankMasked})`;

  const payload = {
    supplierId: supplier.id,
    supplierCode: supplier.supplier_code,
    supplierName: supplier.name,
    oldBankMasked,
    newBankMasked,
    newBankIdentifier: newBank,
    reason: cleanReason,
  };

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const inserted = await client.query<Record<string, unknown>>(
      `
      INSERT INTO approvals (
        entity_type, entity_id, approval_level, requested_by, status, remarks, payload, is_sample_data
      )
      VALUES ('SUPPLIER_BANK_CHANGE', $1, 1, $2, 'PENDING', $3, $4::jsonb, TRUE)
      RETURNING *;
      `,
      [supplier.id, params.actorId, cleanReason, JSON.stringify(payload)]
    );

    await writeAuditLog(
      params.actorId,
      'SUPPLIER_BANK_CHANGE_REQUESTED',
      'suppliers',
      supplier.id,
      {
        supplierCode: supplier.supplier_code,
        approvalId: inserted.rows[0].id,
        oldBankMasked,
        newBankMasked,
        requestedByRole: params.actorRole,
        reason: cleanReason,
      },
      client
    );

    await client.query('COMMIT');

    return {
      message: `Bank identifier change request (${oldBankMasked} -> ${newBankMasked}) submitted for verification by a different Finance Manager. Current bank identifier remains unchanged until approved.`,
      approval: inserted.rows[0],
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function gradeFromScore(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

async function computeScorecardForSupplier(sup: SupplierRow): Promise<SupplierScorecard> {
  const [invRes, poQtyRes, grnQtyRes, invCasesRes, gstrMissingRes, pendingBankRes] =
    await Promise.all([
      query<{
        id: number;
        invoice_number: string;
        invoice_date: string | null;
        total: string;
        status: string;
        risk_level: string;
        risk_score: string;
        extra_charges: string;
        is_historical: boolean;
        latest_match_status: string | null;
      }>(
        `
        SELECT
          i.id,
          i.invoice_number,
          i.invoice_date::text AS invoice_date,
          i.total,
          i.status,
          i.risk_level,
          i.risk_score,
          i.extra_charges,
          i.is_historical,
          mr.status AS latest_match_status
        FROM invoices i
        LEFT JOIN LATERAL (
          SELECT m.status
          FROM match_results m
          WHERE m.invoice_id = i.id
          ORDER BY m.evaluated_at DESC, m.id DESC
          LIMIT 1
        ) mr ON TRUE
        WHERE i.supplier_id = $1
        ORDER BY i.is_historical ASC, i.invoice_date DESC, i.id DESC;
        `,
        [sup.id]
      ),
      query<{ ordered_qty: string }>(
        `
        SELECT COALESCE(SUM(pl.original_quantity), 0)::text AS ordered_qty
        FROM po_lines pl
        JOIN purchase_orders po ON po.id = pl.po_id
        WHERE po.supplier_id = $1;
        `,
        [sup.id]
      ),
      query<{ received_qty: string }>(
        `
        SELECT COALESCE(SUM(gl.quantity_received), 0)::text AS received_qty
        FROM grn_lines gl
        JOIN grns g ON g.id = gl.grn_id
        JOIN purchase_orders po ON po.id = g.po_id
        WHERE po.supplier_id = $1
          AND g.status <> 'SUPERSEDED';
        `,
        [sup.id]
      ),
      query<{
        id: number;
        invoice_id: number | null;
        invoice_number: string | null;
        issue_type: string;
        department: string;
        status: string;
        severity: string;
        description: string | null;
        created_at: string;
        resolved_at: string | null;
      }>(
        `
        SELECT
          inv.id,
          inv.invoice_id,
          i.invoice_number,
          inv.issue_type,
          inv.department,
          inv.status,
          inv.severity,
          inv.description,
          inv.created_at,
          inv.resolved_at
        FROM investigations inv
        LEFT JOIN invoices i ON i.id = inv.invoice_id
        WHERE inv.supplier_id = $1 OR i.supplier_id = $1
        ORDER BY inv.id DESC;
        `,
        [sup.id]
      ),
      query<{ cnt: string }>(
        `
        SELECT COUNT(DISTINCT rf.entity_id)::text AS cnt
        FROM risk_flags rf
        JOIN invoices i ON i.id = rf.entity_id
        WHERE rf.entity_type = 'invoice'
          AND rf.rule_code = 'GSTR2B_MISSING'
          AND rf.is_resolved = FALSE
          AND i.supplier_id = $1;
        `,
        [sup.id]
      ),
      query<{
        id: number;
        payload: { oldBankMasked?: string; newBankMasked?: string };
        requested_by_name: string;
        status: string;
        created_at: string;
      }>(
        `
        SELECT a.id, a.payload, u.name AS requested_by_name, a.status, a.created_at
        FROM approvals a
        JOIN users u ON u.id = a.requested_by
        WHERE a.entity_type = 'SUPPLIER_BANK_CHANGE'
          AND a.entity_id = $1
          AND a.status = 'PENDING'
        ORDER BY a.id DESC;
        `,
        [sup.id]
      ),
    ]);

  const invoices = invRes.rows;
  const totalInvoices = invoices.length;
  const matchedInvoices = invoices.filter(
    (inv) =>
      inv.latest_match_status === 'MATCHED' ||
      (!inv.latest_match_status &&
        ['PAID', 'APPROVED', 'MATCHED', 'ELIGIBLE_FOR_APPROVAL'].includes(inv.status))
  ).length;

  const extraChargeInvoices = invoices.filter((inv) => Number(inv.extra_charges || 0) > 0).length;
  const discrepantInvoices = invoices.filter(
    (inv) =>
      inv.latest_match_status === 'MISMATCH' ||
      inv.latest_match_status === 'HOLD' ||
      inv.status === 'ON_HOLD' ||
      inv.risk_level === 'HIGH' ||
      inv.risk_level === 'CRITICAL'
  ).length;

  const poOrderedQty = Number(poQtyRes.rows[0]?.ordered_qty || 0);
  const grnReceivedQty = Number(grnQtyRes.rows[0]?.received_qty || 0);

  const investigations = invCasesRes.rows;
  const openInvestigations = investigations.filter(
    (c) => c.status !== 'REVALIDATED' && c.status !== 'CLOSED'
  ).length;
  const resolvedInvs = investigations.filter((c) => Boolean(c.resolved_at));
  const avgResolutionHours =
    resolvedInvs.length > 0
      ? Number(
          (
            resolvedInvs.reduce((sum, c) => {
              const ms =
                new Date(c.resolved_at!).getTime() - new Date(c.created_at).getTime();
              return sum + Math.max(0, ms / 3600000);
            }, 0) / resolvedInvs.length
          ).toFixed(2)
        )
      : 0;

  const gstr2bMissingCount = Number(gstrMissingRes.rows[0]?.cnt || 0);

  // Metric 1: Invoice Accuracy (30%)
  const accuracyScore =
    totalInvoices > 0 ? Number(((matchedInvoices / totalInvoices) * 100).toFixed(2)) : 100;

  // Metric 2: Delivery Consistency (20%)
  const deliveryScore =
    poOrderedQty > 0
      ? Number(Math.min(100, (grnReceivedQty / poOrderedQty) * 100).toFixed(2))
      : 100;

  // Metric 3: Repeated Errors / Extra Charges (15%)
  const repeatedErrorScore =
    totalInvoices > 0
      ? Number(Math.max(0, 100 - (extraChargeInvoices / totalInvoices) * 100).toFixed(2))
      : 100;

  // Metric 4: Discrepancy Frequency (15%)
  const discrepancyScore =
    totalInvoices > 0
      ? Number(Math.max(0, (1 - discrepantInvoices / totalInvoices) * 100).toFixed(2))
      : 100;

  // Metric 5: Issue Resolution Time & Backlog (10%)
  const resolutionScore = Number(
    Math.max(
      0,
      100 - openInvestigations * 20 - Math.min(40, avgResolutionHours * 0.5)
    ).toFixed(2)
  );

  // Metric 6: GST Filing Status & GSTR-2B Compliance (10%)
  const filingBase =
    sup.gst_filing_status === 'REGULAR'
      ? 100
      : sup.gst_filing_status === 'DELAYED_FILER'
      ? 45
      : 10;
  const gstScore = Number(Math.max(0, filingBase - gstr2bMissingCount * 20).toFixed(2));

  const metrics: SupplierScorecardMetric[] = [
    {
      key: 'invoice_accuracy',
      label: 'Invoice Accuracy',
      score: accuracyScore,
      weight: 0.3,
      weightedContribution: Number((accuracyScore * 0.3).toFixed(2)),
      formula: 'totalInvoices > 0 ? (matchedInvoices / totalInvoices) * 100 : 100',
      inputs: { matchedInvoices, totalInvoices },
      unit: '%',
    },
    {
      key: 'delivery_consistency',
      label: 'Delivery Consistency',
      score: deliveryScore,
      weight: 0.2,
      weightedContribution: Number((deliveryScore * 0.2).toFixed(2)),
      formula: 'poOrderedQty > 0 ? min(100, (grnReceivedQty / poOrderedQty) * 100) : 100',
      inputs: { grnReceivedQty, poOrderedQty },
      unit: '%',
    },
    {
      key: 'repeated_errors',
      label: 'Repeated Extra Charges Control',
      score: repeatedErrorScore,
      weight: 0.15,
      weightedContribution: Number((repeatedErrorScore * 0.15).toFixed(2)),
      formula: 'totalInvoices > 0 ? max(0, 100 - (extraChargeInvoices / totalInvoices) * 100) : 100',
      inputs: { extraChargeInvoices, totalInvoices },
      unit: 'pts',
    },
    {
      key: 'discrepancy_frequency',
      label: 'Discrepancy-Free Rate',
      score: discrepancyScore,
      weight: 0.15,
      weightedContribution: Number((discrepancyScore * 0.15).toFixed(2)),
      formula: 'totalInvoices > 0 ? max(0, (1 - discrepantInvoices / totalInvoices) * 100) : 100',
      inputs: { discrepantInvoices, totalInvoices },
      unit: '%',
    },
    {
      key: 'issue_resolution_time',
      label: 'Issue Resolution Responsiveness',
      score: resolutionScore,
      weight: 0.1,
      weightedContribution: Number((resolutionScore * 0.1).toFixed(2)),
      formula: 'max(0, 100 - openInvestigations * 20 - min(40, avgResolutionHours * 0.5))',
      inputs: {
        openInvestigations,
        resolvedInvestigations: resolvedInvs.length,
        avgResolutionHours,
      },
      unit: 'pts',
    },
    {
      key: 'gst_filing_status',
      label: 'GST Filing & GSTR-2B Compliance',
      score: gstScore,
      weight: 0.1,
      weightedContribution: Number((gstScore * 0.1).toFixed(2)),
      formula: 'max(0, filingStatusBaseline - gstr2bMissingCount * 20)',
      inputs: {
        gstFilingStatus: sup.gst_filing_status,
        filingStatusBaseline: filingBase,
        gstr2bMissingCount,
      },
      unit: 'pts',
    },
  ];

  const overallScore = Number(
    metrics.reduce((sum, m) => sum + m.weightedContribution, 0).toFixed(2)
  );
  const grade = gradeFromScore(overallScore);

  return {
    supplierId: sup.id,
    supplierCode: sup.supplier_code,
    name: sup.name,
    gstin: sup.gstin,
    pan: sup.pan,
    stateCode: sup.state_code,
    gstFilingStatus: sup.gst_filing_status,
    maskedBankIdentifier: maskBankIdentifier(sup.bank_identifier),
    overallScore,
    grade,
    label: `Performance Score: ${overallScore}/100 (Grade ${grade})`,
    disclaimer:
      'This is an operational performance score derived from matching, delivery, and GST compliance metrics — not a fraud verdict.',
    metrics,
    summary: {
      totalInvoices,
      matchedInvoices,
      poOrderedQty,
      grnReceivedQty,
      repeatedExtraChargeInvoices: extraChargeInvoices,
      discrepantInvoices,
      openInvestigations,
      resolvedInvestigations: resolvedInvs.length,
      avgResolutionHours,
      gstr2bMissingCount,
    },
    linkedInvoices: invoices.map((i) => ({
      id: i.id,
      invoiceNumber: i.invoice_number,
      invoiceDate: i.invoice_date,
      total: Number(i.total || 0),
      status: i.status,
      riskLevel: i.risk_level,
      riskScore: Number(i.risk_score || 0),
      extraCharges: Number(i.extra_charges || 0),
      isHistorical: i.is_historical,
    })),
    linkedInvestigations: investigations.map((c) => ({
      id: c.id,
      invoiceId: c.invoice_id,
      invoiceNumber: c.invoice_number,
      issueType: c.issue_type,
      department: c.department,
      status: c.status,
      severity: c.severity,
      description: c.description,
    })),
    pendingBankChanges: pendingBankRes.rows.map((p) => ({
      approvalId: p.id,
      oldBankMasked: p.payload?.oldBankMasked || 'XXXX',
      newBankMasked: p.payload?.newBankMasked || 'XXXX',
      requestedByName: p.requested_by_name,
      status: p.status,
      createdAt: p.created_at,
    })),
    isSampleData: sup.is_sample_data,
  };
}

export async function getAllSupplierScorecards(): Promise<{
  isSampleData: true;
  disclaimer: string;
  scorecards: SupplierScorecard[];
}> {
  const supRes = await query<SupplierRow>('SELECT * FROM suppliers ORDER BY id ASC');
  const scorecards = await Promise.all(supRes.rows.map((s) => computeScorecardForSupplier(s)));
  return {
    isSampleData: true,
    disclaimer:
      'Operational performance scores reflect invoice accuracy, delivery consistency, and GST compliance — never a fraud verdict.',
    scorecards,
  };
}

export async function getSupplierScorecardById(supplierId: number): Promise<SupplierScorecard> {
  const supRes = await query<SupplierRow>('SELECT * FROM suppliers WHERE id = $1 LIMIT 1', [
    supplierId,
  ]);
  if (supRes.rowCount === 0) {
    throw new HttpError(404, `Supplier #${supplierId} not found.`);
  }
  return computeScorecardForSupplier(supRes.rows[0]);
}
