import { PoolClient } from 'pg';
import { UserRole } from '../auth/permissions.ts';
import { getPool, query } from '../db/pool.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { writeAuditLog } from './auditService.ts';
import {
  ActivePipelineIssue,
  FullPipelineResult,
  PipelineIssueType,
  runFullInvoicePipeline,
} from './riskPipelineService.ts';

export type InvestigationStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'RESOLVED'
  | 'REVALIDATED'
  | 'REOPENED'
  | 'CLOSED';

export interface InvestigationRecord {
  id: number;
  invoice_id: number | null;
  invoice_number?: string | null;
  invoice_status?: string | null;
  invoice_risk_level?: string | null;
  invoice_itc_at_risk?: string | null;
  supplier_id: number | null;
  supplier_name?: string | null;
  issue_type: string;
  department: string;
  allowed_departments: string[];
  assigned_to: number | null;
  assigned_to_name?: string | null;
  assigned_to_role?: string | null;
  status: InvestigationStatus;
  severity: string;
  title: string | null;
  description: string | null;
  evidence: Record<string, unknown>;
  resolution_notes: string | null;
  revalidation_summary: Record<string, unknown>;
  last_revalidated_at: string | null;
  resolved_by: number | null;
  resolved_by_name?: string | null;
  resolved_at: string | null;
  is_sample_data: boolean;
  created_at: string;
  updated_at: string;
}

export interface InvestigationCommentRecord {
  id: number;
  investigation_id: number;
  author_id: number | null;
  author_name?: string | null;
  author_role?: string | null;
  comment: string;
  status_from: string | null;
  status_to: string | null;
  created_at: string;
}

export interface InvestigationEvidenceRecord {
  id: number;
  investigation_id: number;
  added_by: number | null;
  added_by_name?: string | null;
  evidence_type: 'NOTE' | 'FILE' | 'RECORD_LINK';
  note: string | null;
  file_path: string | null;
  original_filename: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  linked_entity_type: string | null;
  linked_entity_id: string | null;
  created_at: string;
}

interface DepartmentRule {
  department: string;
  allowedDepartments: string[];
  roles: UserRole[];
}

export function getDepartmentRuleForIssue(issueType: PipelineIssueType): DepartmentRule {
  switch (issueType) {
    case 'QUANTITY_MISMATCH':
      return {
        department: 'WAREHOUSE',
        allowedDepartments: ['WAREHOUSE'],
        roles: ['WAREHOUSE_EMPLOYEE'],
      };
    case 'PRICE_MISMATCH':
    case 'UNAPPROVED_PO_CHANGE':
      return {
        department: 'PROCUREMENT & FINANCE',
        allowedDepartments: ['PROCUREMENT', 'FINANCE'],
        roles: ['PROCUREMENT_EMPLOYEE', 'FINANCE_MANAGER'],
      };
    case 'POSSIBLE_DUPLICATE':
    case 'REPEATED_OVERBILLING':
      return {
        department: 'AP & FINANCE',
        allowedDepartments: ['AP', 'FINANCE'],
        roles: ['AP_EMPLOYEE', 'FINANCE_MANAGER'],
      };
    case 'GST_ITC_RISK':
    case 'SUPPLIER_RISK':
    default:
      return {
        department: 'FINANCE & COMPLIANCE',
        allowedDepartments: ['FINANCE', 'COMPLIANCE'],
        // Compliance maps to Finance Manager when no separate Compliance role exists
        roles: ['FINANCE_MANAGER'],
      };
  }
}

export function getRoleDepartmentKeys(role: UserRole): string[] {
  switch (role) {
    case 'WAREHOUSE_EMPLOYEE':
      return ['WAREHOUSE'];
    case 'PROCUREMENT_EMPLOYEE':
      return ['PROCUREMENT'];
    case 'AP_EMPLOYEE':
      return ['AP'];
    case 'FINANCE_MANAGER':
      return ['FINANCE', 'COMPLIANCE'];
    case 'ADMIN':
    default:
      return [];
  }
}

export function canUserMutateInvestigation(
  userId: number,
  userRole: UserRole,
  inv: { allowed_departments: string[] | unknown; department: string; assigned_to: number | null }
): boolean {
  if (userRole === 'ADMIN') return false;

  const allowedDepts = Array.isArray(inv.allowed_departments)
    ? inv.allowed_departments.map((d) => String(d).toUpperCase())
    : [];
  const roleKeys = getRoleDepartmentKeys(userRole);

  if (roleKeys.some((k) => allowedDepts.includes(k))) {
    return true;
  }

  // Fallback check on department label string
  const deptUpper = (inv.department || '').toUpperCase();
  if (roleKeys.some((k) => deptUpper.includes(k))) {
    return true;
  }

  if (inv.assigned_to !== null && Number(inv.assigned_to) === Number(userId)) {
    return true;
  }

  return false;
}

async function pickRoundRobinAssignee(
  client: PoolClient,
  department: string,
  roles: UserRole[]
): Promise<number | null> {
  const usersRes = await client.query<{ id: number }>(
    `
    SELECT id
    FROM users
    WHERE is_active = TRUE
      AND role = ANY($1::text[])
    ORDER BY id ASC;
    `,
    [roles]
  );

  if (usersRes.rows.length === 0) return null;

  const countRes = await client.query<{ cnt: string }>(
    'SELECT COUNT(*)::text AS cnt FROM investigations WHERE department = $1',
    [department]
  );
  const existingCount = Number(countRes.rows[0]?.cnt || 0);
  const index = existingCount % usersRes.rows.length;
  return usersRes.rows[index].id;
}

async function reconcileInvoicePaymentGate(
  client: PoolClient,
  invoiceId: number,
  matchStatus: string
): Promise<string> {
  const invRes = await client.query<{ status: string }>(
    'SELECT status FROM invoices WHERE id = $1 LIMIT 1',
    [invoiceId]
  );
  const currentStatus = invRes.rows[0]?.status;
  if (currentStatus === 'APPROVED' || currentStatus === 'PAID') {
    return currentStatus;
  }

  const allInvRes = await client.query<{ id: number; status: InvestigationStatus }>(
    'SELECT id, status FROM investigations WHERE invoice_id = $1',
    [invoiceId]
  );

  const totalInvestigations = allInvRes.rows.length;
  const allRevalidated =
    totalInvestigations > 0 && allInvRes.rows.every((row) => row.status === 'REVALIDATED');

  const nextStatus =
    matchStatus === 'MATCHED' && (totalInvestigations === 0 || allRevalidated)
      ? 'ELIGIBLE_FOR_APPROVAL'
      : 'ON_HOLD';

  await client.query('UPDATE invoices SET status = $1 WHERE id = $2', [nextStatus, invoiceId]);
  return nextStatus;
}

async function upsertInvestigationsFromPipeline(
  client: PoolClient,
  pipeline: FullPipelineResult,
  actorId: number | null,
  skipIssueType?: string
): Promise<void> {
  const existingRes = await client.query<{
    id: number;
    issue_type: string;
    status: InvestigationStatus;
  }>(
    'SELECT id, issue_type, status FROM investigations WHERE invoice_id = $1',
    [pipeline.invoiceId]
  );

  const existingByType = new Map<string, { id: number; status: InvestigationStatus }>();
  for (const row of existingRes.rows) {
    existingByType.set(row.issue_type, { id: row.id, status: row.status });
  }

  for (const issue of pipeline.activeIssues) {
    if (skipIssueType && issue.issueType === skipIssueType) {
      continue;
    }

    const existing = existingByType.get(issue.issueType);
    const rule = getDepartmentRuleForIssue(issue.issueType);

    if (!existing) {
      const assignedTo = await pickRoundRobinAssignee(client, rule.department, rule.roles);
      const insertedRes = await client.query<{ id: number }>(
        `
        INSERT INTO investigations (
          invoice_id, supplier_id, issue_type, department, allowed_departments,
          assigned_to, status, severity, title, description, evidence, is_sample_data
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'OPEN', $7, $8, $9, $10::jsonb, TRUE)
        RETURNING id;
        `,
        [
          pipeline.invoiceId,
          pipeline.supplierId,
          issue.issueType,
          rule.department,
          JSON.stringify(rule.allowedDepartments),
          assignedTo,
          issue.severity,
          issue.title,
          issue.description,
          JSON.stringify(issue.evidence),
        ]
      );
      const newInvId = insertedRes.rows[0].id;

      await client.query(
        `
        INSERT INTO investigation_comments (investigation_id, author_id, comment, status_from, status_to, is_sample_data)
        VALUES ($1, $2, $3, NULL, 'OPEN', TRUE);
        `,
        [
          newInvId,
          actorId,
          `Auto-created from risk pipeline: ${issue.description}`,
        ]
      );

      await writeAuditLog(
        actorId,
        'INVESTIGATION_AUTO_CREATED',
        'investigations',
        newInvId,
        {
          invoiceId: pipeline.invoiceId,
          issueType: issue.issueType,
          department: rule.department,
          assignedTo,
          severity: issue.severity,
        },
        client
      );
    } else if (existing.status === 'REVALIDATED' || existing.status === 'CLOSED') {
      await client.query(
        `
        UPDATE investigations
        SET status = 'REOPENED',
            severity = $1,
            description = $2,
            evidence = $3::jsonb,
            updated_at = NOW()
        WHERE id = $4;
        `,
        [issue.severity, issue.description, JSON.stringify(issue.evidence), existing.id]
      );

      await client.query(
        `
        INSERT INTO investigation_comments (investigation_id, author_id, comment, status_from, status_to, is_sample_data)
        VALUES ($1, $2, $3, $4, 'REOPENED', TRUE);
        `,
        [
          existing.id,
          actorId,
          `Pipeline re-run detected recurring issue: ${issue.description}`,
          existing.status,
        ]
      );
    } else {
      await client.query(
        `
        UPDATE investigations
        SET severity = $1,
            description = $2,
            evidence = $3::jsonb,
            updated_at = NOW()
        WHERE id = $4;
        `,
        [issue.severity, issue.description, JSON.stringify(issue.evidence), existing.id]
      );
    }
  }
}

/**
 * Runs the full risk/matching/GST/PO/overbilling pipeline on an invoice,
 * auto-creates/syncs investigations without duplicates, and updates payment gate status.
 */
export async function syncAndEvaluateInvoice(
  invoiceId: number,
  actorId: number | null = null,
  externalClient?: PoolClient
): Promise<{
  pipeline: FullPipelineResult;
  invoiceStatus: string;
}> {
  const pool = getPool();
  const ownsClient = !externalClient;
  const client = externalClient ?? (await pool.connect());

  try {
    if (ownsClient) {
      await client.query('BEGIN');
    }

    const pipeline = await runFullInvoicePipeline(invoiceId, actorId, client);
    await upsertInvestigationsFromPipeline(client, pipeline, actorId);
    const invoiceStatus = await reconcileInvoicePaymentGate(
      client,
      invoiceId,
      pipeline.matchResult.status
    );

    if (ownsClient) {
      await client.query('COMMIT');
    }

    return { pipeline, invoiceStatus };
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

export async function listInvestigations(filters: {
  status?: string;
  department?: string;
  assignee?: string;
  invoiceId?: number;
}): Promise<InvestigationRecord[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (filters.status && filters.status.toUpperCase() !== 'ALL') {
    params.push(filters.status.toUpperCase());
    conditions.push(`inv.status = $${params.length}`);
  }

  if (filters.department && filters.department.toUpperCase() !== 'ALL') {
    params.push(`%${filters.department.trim().toUpperCase()}%`);
    conditions.push(`UPPER(inv.department) LIKE $${params.length}`);
  }

  if (filters.assignee && filters.assignee !== 'ALL') {
    const assigneeId = Number(filters.assignee);
    if (!Number.isNaN(assigneeId) && assigneeId > 0) {
      params.push(assigneeId);
      conditions.push(`inv.assigned_to = $${params.length}`);
    }
  }

  if (filters.invoiceId && Number.isFinite(filters.invoiceId)) {
    params.push(filters.invoiceId);
    conditions.push(`inv.invoice_id = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const res = await query<InvestigationRecord>(
    `
    SELECT
      inv.*,
      i.invoice_number,
      i.status AS invoice_status,
      i.risk_level AS invoice_risk_level,
      i.itc_at_risk AS invoice_itc_at_risk,
      COALESCE(s.name, i.supplier_name_extracted) AS supplier_name,
      u.name AS assigned_to_name,
      u.role AS assigned_to_role,
      ru.name AS resolved_by_name
    FROM investigations inv
    LEFT JOIN invoices i ON i.id = inv.invoice_id
    LEFT JOIN suppliers s ON s.id = COALESCE(inv.supplier_id, i.supplier_id)
    LEFT JOIN users u ON u.id = inv.assigned_to
    LEFT JOIN users ru ON ru.id = inv.resolved_by
    ${whereClause}
    ORDER BY
      CASE inv.status
        WHEN 'OPEN' THEN 0
        WHEN 'REOPENED' THEN 1
        WHEN 'IN_PROGRESS' THEN 2
        WHEN 'RESOLVED' THEN 3
        ELSE 4
      END,
      inv.id DESC;
    `,
    params
  );

  return res.rows;
}

export async function getInvestigationDetail(investigationId: number): Promise<{
  investigation: InvestigationRecord;
  comments: InvestigationCommentRecord[];
  evidenceItems: InvestigationEvidenceRecord[];
  assignableUsers: Array<{ id: number; name: string; role: UserRole; department: string }>;
}> {
  const res = await query<InvestigationRecord>(
    `
    SELECT
      inv.*,
      i.invoice_number,
      i.status AS invoice_status,
      i.risk_level AS invoice_risk_level,
      i.itc_at_risk AS invoice_itc_at_risk,
      COALESCE(s.name, i.supplier_name_extracted) AS supplier_name,
      u.name AS assigned_to_name,
      u.role AS assigned_to_role,
      ru.name AS resolved_by_name
    FROM investigations inv
    LEFT JOIN invoices i ON i.id = inv.invoice_id
    LEFT JOIN suppliers s ON s.id = COALESCE(inv.supplier_id, i.supplier_id)
    LEFT JOIN users u ON u.id = inv.assigned_to
    LEFT JOIN users ru ON ru.id = inv.resolved_by
    WHERE inv.id = $1
    LIMIT 1;
    `,
    [investigationId]
  );

  if (res.rowCount === 0) {
    throw new HttpError(404, `Investigation #${investigationId} not found.`);
  }

  const [commentsRes, evidenceRes, usersRes] = await Promise.all([
    query<InvestigationCommentRecord>(
      `
      SELECT c.*, u.name AS author_name, u.role AS author_role
      FROM investigation_comments c
      LEFT JOIN users u ON u.id = c.author_id
      WHERE c.investigation_id = $1
      ORDER BY c.created_at ASC, c.id ASC;
      `,
      [investigationId]
    ),
    query<InvestigationEvidenceRecord>(
      `
      SELECT e.*, u.name AS added_by_name
      FROM investigation_evidence e
      LEFT JOIN users u ON u.id = e.added_by
      WHERE e.investigation_id = $1
      ORDER BY e.created_at DESC, e.id DESC;
      `,
      [investigationId]
    ),
    query<{ id: number; name: string; role: UserRole; department: string }>(
      `
      SELECT id, name, role, department
      FROM users
      WHERE is_active = TRUE AND role <> 'ADMIN'
      ORDER BY id ASC;
      `
    ),
  ]);

  return {
    investigation: res.rows[0],
    comments: commentsRes.rows,
    evidenceItems: evidenceRes.rows,
    assignableUsers: usersRes.rows,
  };
}

export async function transitionInvestigationStatus(params: {
  investigationId: number;
  actorId: number;
  actorRole: UserRole;
  targetStatus: 'IN_PROGRESS' | 'RESOLVED';
  comment: string;
}): Promise<{
  investigation: InvestigationRecord;
  revalidation: {
    ran: boolean;
    outcome: 'REVALIDATED' | 'REOPENED' | null;
    reason: string | null;
    remainingIssues: string[];
  };
  invoiceStatus: string | null;
}> {
  const cleanComment = (params.comment || '').trim();
  if (!cleanComment) {
    throw new HttpError(400, 'A comment is required for every investigation status change.');
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const lockRes = await client.query<InvestigationRecord>(
      'SELECT * FROM investigations WHERE id = $1 FOR UPDATE',
      [params.investigationId]
    );

    if (lockRes.rowCount === 0) {
      throw new HttpError(404, `Investigation #${params.investigationId} not found.`);
    }

    const inv = lockRes.rows[0];

    if (!canUserMutateInvestigation(params.actorId, params.actorRole, inv)) {
      await writeAuditLog(
        params.actorId,
        'ACCESS_DENIED_403',
        'investigations',
        params.investigationId,
        {
          attemptedStatus: params.targetStatus,
          userRole: params.actorRole,
          investigationDepartment: inv.department,
          allowedDepartments: inv.allowed_departments,
        },
        client
      );
      await client.query('COMMIT');
      throw new HttpError(
        403,
        `Forbidden: ${params.actorRole} cannot update an investigation assigned to ${inv.department}.`
      );
    }

    if (inv.status === 'REVALIDATED' || inv.status === 'CLOSED') {
      throw new HttpError(
        409,
        `Investigation #${params.investigationId} is already ${inv.status}.`
      );
    }

    const prevStatus = inv.status;

    if (params.targetStatus === 'IN_PROGRESS') {
      await client.query(
        `
        UPDATE investigations
        SET status = 'IN_PROGRESS',
            resolution_notes = COALESCE(resolution_notes, '') || CASE WHEN resolution_notes IS NULL OR resolution_notes = '' THEN '' ELSE E'\n' END || $1,
            updated_at = NOW()
        WHERE id = $2;
        `,
        [cleanComment, params.investigationId]
      );

      await client.query(
        `
        INSERT INTO investigation_comments (investigation_id, author_id, comment, status_from, status_to, is_sample_data)
        VALUES ($1, $2, $3, $4, 'IN_PROGRESS', TRUE);
        `,
        [params.investigationId, params.actorId, cleanComment, prevStatus]
      );

      await writeAuditLog(
        params.actorId,
        'INVESTIGATION_STATUS_CHANGED',
        'investigations',
        params.investigationId,
        {
          invoiceId: inv.invoice_id,
          issueType: inv.issue_type,
          fromStatus: prevStatus,
          toStatus: 'IN_PROGRESS',
          comment: cleanComment,
        },
        client
      );

      await client.query('COMMIT');
      const detail = await getInvestigationDetail(params.investigationId);
      return {
        investigation: detail.investigation,
        revalidation: { ran: false, outcome: null, reason: null, remainingIssues: [] },
        invoiceStatus: detail.investigation.invoice_status ?? null,
      };
    }

    // Target is RESOLVED -> Log RESOLVED, then immediately re-run full pipeline for real revalidation
    await client.query(
      `
      UPDATE investigations
      SET status = 'RESOLVED',
          resolution_notes = $1,
          resolved_by = $2,
          resolved_at = NOW(),
          updated_at = NOW()
      WHERE id = $3;
      `,
      [cleanComment, params.actorId, params.investigationId]
    );

    await client.query(
      `
      INSERT INTO investigation_comments (investigation_id, author_id, comment, status_from, status_to, is_sample_data)
      VALUES ($1, $2, $3, $4, 'RESOLVED', TRUE);
      `,
      [params.investigationId, params.actorId, cleanComment, prevStatus]
    );

    await writeAuditLog(
      params.actorId,
      'INVESTIGATION_STATUS_CHANGED',
      'investigations',
      params.investigationId,
      {
        invoiceId: inv.invoice_id,
        issueType: inv.issue_type,
        fromStatus: prevStatus,
        toStatus: 'RESOLVED',
        comment: cleanComment,
      },
      client
    );

    let outcome: 'REVALIDATED' | 'REOPENED' = 'REVALIDATED';
    let revalReason: string | null = null;
    let remainingIssues: string[] = [];
    let invoiceStatus: string | null = null;

    if (inv.invoice_id) {
      const pipeline = await runFullInvoicePipeline(inv.invoice_id, params.actorId, client);
      await upsertInvestigationsFromPipeline(client, pipeline, params.actorId, inv.issue_type);

      const stillActive = pipeline.activeIssues.find((i) => i.issueType === inv.issue_type);
      remainingIssues = pipeline.activeIssues.map((i) => i.issueType);

      if (stillActive) {
        outcome = 'REOPENED';
        revalReason = stillActive.description;

        const summary = {
          outcome: 'REOPENED',
          checkedAt: pipeline.evaluatedAt,
          reason: revalReason,
          remainingIssues,
        };

        await client.query(
          `
          UPDATE investigations
          SET status = 'REOPENED',
              description = $1,
              evidence = $2::jsonb,
              revalidation_summary = $3::jsonb,
              last_revalidated_at = NOW(),
              updated_at = NOW()
          WHERE id = $4;
          `,
          [
            stillActive.description,
            JSON.stringify(stillActive.evidence),
            JSON.stringify(summary),
            params.investigationId,
          ]
        );

        await client.query(
          `
          INSERT INTO investigation_comments (investigation_id, author_id, comment, status_from, status_to, is_sample_data)
          VALUES ($1, $2, $3, 'RESOLVED', 'REOPENED', TRUE);
          `,
          [
            params.investigationId,
            params.actorId,
            `Revalidation failed — issue persists and was REOPENED: ${revalReason}`,
          ]
        );

        await writeAuditLog(
          params.actorId,
          'INVESTIGATION_REOPENED',
          'investigations',
          params.investigationId,
          {
            invoiceId: inv.invoice_id,
            issueType: inv.issue_type,
            reason: revalReason,
            remainingIssues,
          },
          client
        );
      } else {
        outcome = 'REVALIDATED';
        revalReason = `${inv.issue_type} cleared after full pipeline revalidation.`;

        const summary = {
          outcome: 'REVALIDATED',
          checkedAt: pipeline.evaluatedAt,
          reason: revalReason,
          remainingIssues,
        };

        await client.query(
          `
          UPDATE investigations
          SET status = 'REVALIDATED',
              revalidation_summary = $1::jsonb,
              last_revalidated_at = NOW(),
              updated_at = NOW()
          WHERE id = $2;
          `,
          [JSON.stringify(summary), params.investigationId]
        );

        await client.query(
          `
          INSERT INTO investigation_comments (investigation_id, author_id, comment, status_from, status_to, is_sample_data)
          VALUES ($1, $2, $3, 'RESOLVED', 'REVALIDATED', TRUE);
          `,
          [
            params.investigationId,
            params.actorId,
            `Revalidation passed — ${inv.issue_type} is cleared. Status set to REVALIDATED.`,
          ]
        );

        await writeAuditLog(
          params.actorId,
          'INVESTIGATION_REVALIDATED',
          'investigations',
          params.investigationId,
          {
            invoiceId: inv.invoice_id,
            issueType: inv.issue_type,
            remainingIssues,
          },
          client
        );
      }

      invoiceStatus = await reconcileInvoicePaymentGate(
        client,
        inv.invoice_id,
        pipeline.matchResult.status
      );
    } else {
      await client.query(
        `
        UPDATE investigations
        SET status = 'REVALIDATED',
            last_revalidated_at = NOW(),
            updated_at = NOW()
        WHERE id = $1;
        `,
        [params.investigationId]
      );
    }

    await client.query('COMMIT');

    const detail = await getInvestigationDetail(params.investigationId);
    return {
      investigation: detail.investigation,
      revalidation: {
        ran: true,
        outcome,
        reason: revalReason,
        remainingIssues,
      },
      invoiceStatus,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function addInvestigationComment(params: {
  investigationId: number;
  actorId: number;
  actorRole: UserRole;
  comment: string;
}): Promise<InvestigationCommentRecord> {
  const cleanComment = (params.comment || '').trim();
  if (!cleanComment) {
    throw new HttpError(400, 'Comment text is required.');
  }

  const invRes = await query<InvestigationRecord>(
    'SELECT * FROM investigations WHERE id = $1 LIMIT 1',
    [params.investigationId]
  );
  if (invRes.rowCount === 0) {
    throw new HttpError(404, `Investigation #${params.investigationId} not found.`);
  }
  const inv = invRes.rows[0];

  if (
    params.actorRole !== 'FINANCE_MANAGER' &&
    !canUserMutateInvestigation(params.actorId, params.actorRole, inv)
  ) {
    throw new HttpError(
      403,
      `Forbidden: ${params.actorRole} cannot comment on ${inv.department} investigation.`
    );
  }

  const insertRes = await query<InvestigationCommentRecord>(
    `
    INSERT INTO investigation_comments (investigation_id, author_id, comment, is_sample_data)
    VALUES ($1, $2, $3, TRUE)
    RETURNING *;
    `,
    [params.investigationId, params.actorId, cleanComment]
  );

  await writeAuditLog(params.actorId, 'INVESTIGATION_COMMENT_ADDED', 'investigations', params.investigationId, {
    invoiceId: inv.invoice_id,
    comment: cleanComment,
  });

  return insertRes.rows[0];
}

export async function addInvestigationEvidence(params: {
  investigationId: number;
  actorId: number;
  actorRole: UserRole;
  evidenceType: 'NOTE' | 'FILE' | 'RECORD_LINK';
  note?: string | null;
  filePath?: string | null;
  originalFilename?: string | null;
  mimeType?: string | null;
  fileSizeBytes?: number | null;
  linkedEntityType?: string | null;
  linkedEntityId?: string | null;
}): Promise<InvestigationEvidenceRecord> {
  const invRes = await query<InvestigationRecord>(
    'SELECT * FROM investigations WHERE id = $1 LIMIT 1',
    [params.investigationId]
  );
  if (invRes.rowCount === 0) {
    throw new HttpError(404, `Investigation #${params.investigationId} not found.`);
  }
  const inv = invRes.rows[0];

  if (
    params.actorRole !== 'FINANCE_MANAGER' &&
    !canUserMutateInvestigation(params.actorId, params.actorRole, inv)
  ) {
    throw new HttpError(
      403,
      `Forbidden: ${params.actorRole} cannot attach evidence to ${inv.department} investigation.`
    );
  }

  const insertRes = await query<InvestigationEvidenceRecord>(
    `
    INSERT INTO investigation_evidence (
      investigation_id, added_by, evidence_type, note, file_path,
      original_filename, mime_type, file_size_bytes, linked_entity_type, linked_entity_id, is_sample_data
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
    RETURNING *;
    `,
    [
      params.investigationId,
      params.actorId,
      params.evidenceType,
      params.note ?? null,
      params.filePath ?? null,
      params.originalFilename ?? null,
      params.mimeType ?? null,
      params.fileSizeBytes ?? null,
      params.linkedEntityType ?? null,
      params.linkedEntityId ?? null,
    ]
  );

  await writeAuditLog(params.actorId, 'INVESTIGATION_EVIDENCE_ADDED', 'investigations', params.investigationId, {
    invoiceId: inv.invoice_id,
    evidenceId: insertRes.rows[0].id,
    evidenceType: params.evidenceType,
    originalFilename: params.originalFilename ?? null,
    note: params.note ?? null,
  });

  return insertRes.rows[0];
}

export async function reassignInvestigation(params: {
  investigationId: number;
  actorId: number;
  actorRole: UserRole;
  assignedTo: number;
  comment?: string;
}): Promise<InvestigationRecord> {
  if (params.actorRole !== 'FINANCE_MANAGER') {
    throw new HttpError(403, 'Forbidden: Only Finance Manager can reassign investigations.');
  }

  const userRes = await query<{ id: number; name: string; role: string }>(
    "SELECT id, name, role FROM users WHERE id = $1 AND is_active = TRUE AND role <> 'ADMIN' LIMIT 1",
    [params.assignedTo]
  );
  if (userRes.rowCount === 0) {
    throw new HttpError(400, 'Selected assignee user does not exist or cannot be assigned investigations.');
  }
  const targetUser = userRes.rows[0];

  const invRes = await query<InvestigationRecord>(
    'SELECT * FROM investigations WHERE id = $1 LIMIT 1',
    [params.investigationId]
  );
  if (invRes.rowCount === 0) {
    throw new HttpError(404, `Investigation #${params.investigationId} not found.`);
  }
  const inv = invRes.rows[0];

  await query(
    'UPDATE investigations SET assigned_to = $1, updated_at = NOW() WHERE id = $2',
    [params.assignedTo, params.investigationId]
  );

  const note =
    params.comment?.trim() ||
    `Reassigned by Finance Manager to ${targetUser.name} (${targetUser.role})`;

  await query(
    `
    INSERT INTO investigation_comments (investigation_id, author_id, comment, is_sample_data)
    VALUES ($1, $2, $3, TRUE);
    `,
    [params.investigationId, params.actorId, note]
  );

  await writeAuditLog(params.actorId, 'INVESTIGATION_REASSIGNED', 'investigations', params.investigationId, {
    invoiceId: inv.invoice_id,
    previousAssignee: inv.assigned_to,
    newAssignee: params.assignedTo,
    newAssigneeName: targetUser.name,
  });

  const detail = await getInvestigationDetail(params.investigationId);
  return detail.investigation;
}

/**
 * Payment Gate & Multi-Level Human Approval on Invoices:
 * - Never automatic
 * - Blocked if ANY investigation for the invoice is NOT REVALIDATED
 * - High/Critical risk invoices require 2 DIFFERENT human approvers (Level 1 + Final Level 2 Finance Manager)
 * - Maker-checker: approver cannot be the same user who created any related PO change or uploaded the invoice
 */
export async function approveInvoicePayment(params: {
  invoiceId: number;
  approverId: number;
  approverRole: UserRole;
  level: 1 | 2;
  remarks?: string;
}): Promise<{
  invoiceId: number;
  status: string;
  levelApproved: number;
  level1ApprovedBy: number | null;
  paymentApprovedBy: number | null;
  message: string;
}> {
  if (params.approverRole === 'ADMIN') {
    await writeAuditLog(params.approverId, 'ACCESS_DENIED_403', 'invoices', params.invoiceId, {
      attemptedAction: 'APPROVE_PAYMENT',
      reason: 'Admin is not permitted to approve payments.',
    });
    throw new HttpError(403, 'Forbidden: Admin is not permitted to approve payments.');
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const invRes = await client.query<{
      id: number;
      invoice_number: string | null;
      po_id: number | null;
      status: string;
      risk_level: string;
      uploaded_by: number | null;
      level1_approved_by: number | null;
      payment_approved_by: number | null;
    }>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [params.invoiceId]);

    if (invRes.rowCount === 0) {
      throw new HttpError(404, `Invoice #${params.invoiceId} not found.`);
    }
    const invoice = invRes.rows[0];

    if (invoice.status === 'APPROVED' || invoice.status === 'PAID') {
      throw new HttpError(409, `Invoice #${params.invoiceId} payment is already ${invoice.status}.`);
    }

    // 1. Check all investigations: EVERY investigation must be REVALIDATED
    const invsRes = await client.query<{ id: number; issue_type: string; status: string }>(
      'SELECT id, issue_type, status FROM investigations WHERE invoice_id = $1',
      [params.invoiceId]
    );
    const pendingInvs = invsRes.rows.filter((row) => row.status !== 'REVALIDATED');
    if (pendingInvs.length > 0) {
      await writeAuditLog(
        params.approverId,
        'PAYMENT_GATE_BLOCKED',
        'invoices',
        params.invoiceId,
        {
          reason: 'Unrevalidated investigations present',
          pendingIssues: pendingInvs.map((p) => `${p.issue_type}:${p.status}`),
        },
        client
      );
      await client.query('COMMIT');
      throw new HttpError(
        409,
        `Payment blocked: ${pendingInvs.length} investigation(s) are not REVALIDATED (${pendingInvs
          .map((p) => `${p.issue_type} [${p.status}]`)
          .join(', ')}).`
      );
    }

    if (invoice.status !== 'ELIGIBLE_FOR_APPROVAL') {
      throw new HttpError(
        409,
        `Payment blocked: invoice status is ${invoice.status}; must be ELIGIBLE_FOR_APPROVAL.`
      );
    }

    // 2. Enforce maker-checker against PO change creators
    if (invoice.po_id) {
      const poCreatorRes = await client.query<{ changed_by: number }>(
        'SELECT changed_by FROM po_change_history WHERE po_id = $1',
        [invoice.po_id]
      );
      const isChangeCreator = poCreatorRes.rows.some(
        (r) => Number(r.changed_by) === Number(params.approverId)
      );
      if (isChangeCreator) {
        await writeAuditLog(
          params.approverId,
          'MAKER_CHECKER_VIOLATION',
          'invoices',
          params.invoiceId,
          {
            attemptedAction: 'APPROVE_PAYMENT',
            reason: 'Approver created a PO modification linked to this invoice.',
          },
          client
        );
        await client.query('COMMIT');
        throw new HttpError(
          403,
          'Maker-checker violation: approver cannot be the same user who created a related PO change.'
        );
      }
    }

    const isHighRisk = invoice.risk_level === 'HIGH' || invoice.risk_level === 'CRITICAL';

    if (params.level === 1) {
      if (!isHighRisk) {
        throw new HttpError(400, 'Level 1 sign-off is only required for HIGH/CRITICAL risk invoices.');
      }
      if (invoice.level1_approved_by) {
        throw new HttpError(409, 'Level 1 sign-off has already been completed.');
      }
      if (invoice.uploaded_by && Number(invoice.uploaded_by) === Number(params.approverId)) {
        throw new HttpError(
          403,
          'Maker-checker violation: invoice uploader cannot sign off Level 1 review.'
        );
      }

      await client.query(
        'UPDATE invoices SET level1_approved_by = $1, level1_approved_at = NOW() WHERE id = $2',
        [params.approverId, params.invoiceId]
      );

      await writeAuditLog(
        params.approverId,
        'PAYMENT_LEVEL1_APPROVED',
        'invoices',
        params.invoiceId,
        {
          invoiceNumber: invoice.invoice_number,
          riskLevel: invoice.risk_level,
          remarks: params.remarks ?? null,
        },
        client
      );

      await client.query('COMMIT');
      return {
        invoiceId: params.invoiceId,
        status: 'ELIGIBLE_FOR_APPROVAL',
        levelApproved: 1,
        level1ApprovedBy: params.approverId,
        paymentApprovedBy: null,
        message: 'Level 1 compliance sign-off recorded. A different Finance Manager must complete Level 2 final payment approval.',
      };
    }

    // Level 2: Final Payment Approval -> Finance Manager ONLY
    if (params.approverRole !== 'FINANCE_MANAGER') {
      await writeAuditLog(
        params.approverId,
        'ACCESS_DENIED_403',
        'invoices',
        params.invoiceId,
        {
          attemptedAction: 'FINAL_PAYMENT_APPROVAL',
          userRole: params.approverRole,
          requiredRole: 'FINANCE_MANAGER',
        },
        client
      );
      await client.query('COMMIT');
      throw new HttpError(
        403,
        'Forbidden: Final payment approval is restricted strictly to Finance Manager.'
      );
    }

    if (isHighRisk) {
      if (!invoice.level1_approved_by) {
        throw new HttpError(
          409,
          'Multi-level approval required: High-risk invoice requires Level 1 approval from a different reviewer before Finance Manager final payment approval.'
        );
      }
      if (Number(invoice.level1_approved_by) === Number(params.approverId)) {
        await writeAuditLog(
          params.approverId,
          'MAKER_CHECKER_VIOLATION',
          'invoices',
          params.invoiceId,
          {
            attemptedAction: 'FINAL_PAYMENT_APPROVAL',
            reason: 'High-risk invoice requires two different approvers for Level 1 and Level 2.',
          },
          client
        );
        await client.query('COMMIT');
        throw new HttpError(
          403,
          'Maker-checker violation: High-risk invoice requires two different approvers (cannot reuse Level 1 approver).'
        );
      }
    }

    await client.query(
      `
      UPDATE invoices
      SET status = 'APPROVED',
          payment_approved_by = $1,
          payment_approved_at = NOW()
      WHERE id = $2;
      `,
      [params.approverId, params.invoiceId]
    );

    await writeAuditLog(
      params.approverId,
      'PAYMENT_APPROVED_BY_HUMAN',
      'invoices',
      params.invoiceId,
      {
        invoiceNumber: invoice.invoice_number,
        riskLevel: invoice.risk_level,
        level1ApprovedBy: invoice.level1_approved_by,
        finalApprovedBy: params.approverId,
        remarks: params.remarks ?? null,
      },
      client
    );

    await client.query('COMMIT');
    return {
      invoiceId: params.invoiceId,
      status: 'APPROVED',
      levelApproved: 2,
      level1ApprovedBy: invoice.level1_approved_by,
      paymentApprovedBy: params.approverId,
      message: 'Final payment approved by Finance Manager.',
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
