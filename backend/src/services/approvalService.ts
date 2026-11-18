import { UserRole } from '../auth/permissions.ts';
import { getPool, query } from '../db/pool.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { writeAuditLog } from './auditService.ts';

export interface ApprovalRecord {
  id: number;
  entity_type: string;
  entity_id: number;
  approval_level: number;
  requested_by: number;
  requested_by_name?: string;
  requested_by_role?: string;
  approved_by: number | null;
  approved_by_name?: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  remarks: string | null;
  payload: Record<string, unknown>;
  is_sample_data: boolean;
  created_at: string;
  decided_at: string | null;
}

export async function createApprovalRequest(
  entityType: string,
  entityId: number,
  requestedBy: number,
  payload: Record<string, unknown> = {},
  remarks?: string,
  approvalLevel = 1
): Promise<ApprovalRecord> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const res = await client.query<ApprovalRecord>(
      `
      INSERT INTO approvals (
        entity_type, entity_id, approval_level, requested_by, status, remarks, payload, is_sample_data
      )
      VALUES ($1, $2, $3, $4, 'PENDING', $5, $6::jsonb, TRUE)
      RETURNING *;
      `,
      [entityType, entityId, approvalLevel, requestedBy, remarks ?? null, JSON.stringify(payload)]
    );

    const created = res.rows[0];

    await writeAuditLog(
      requestedBy,
      'APPROVAL_CREATED',
      'approvals',
      created.id,
      {
        entityType,
        entityId,
        approvalLevel,
        payload,
      },
      client
    );

    await client.query('COMMIT');
    return created;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listApprovalsByRole(
  userId: number,
  role: UserRole,
  statusFilter?: string
): Promise<ApprovalRecord[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (role !== 'FINANCE_MANAGER' && role !== 'ADMIN') {
    params.push(userId);
    conditions.push(`a.requested_by = $${params.length}`);
  }

  if (statusFilter && ['PENDING', 'APPROVED', 'REJECTED'].includes(statusFilter.toUpperCase())) {
    params.push(statusFilter.toUpperCase());
    conditions.push(`a.status = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const res = await query<ApprovalRecord>(
    `
    SELECT
      a.*,
      req_user.name AS requested_by_name,
      req_user.role AS requested_by_role,
      app_user.name AS approved_by_name
    FROM approvals a
    JOIN users req_user ON req_user.id = a.requested_by
    LEFT JOIN users app_user ON app_user.id = a.approved_by
    ${whereClause}
    ORDER BY
      CASE WHEN a.status = 'PENDING' THEN 0 ELSE 1 END,
      a.id DESC;
    `,
    params
  );

  return res.rows;
}

export async function approve(
  approvalId: number,
  approverId: number,
  approverRole: UserRole,
  remarks?: string
): Promise<ApprovalRecord> {
  const pool = getPool();
  const client = await pool.connect();

  let violationAudit: {
    action: string;
    entity: string;
    entityId: string;
    payload: Record<string, unknown>;
    statusCode: number;
    message: string;
  } | null = null;

  try {
    await client.query('BEGIN');

    const lockRes = await client.query<ApprovalRecord>(
      'SELECT * FROM approvals WHERE id = $1 FOR UPDATE',
      [approvalId]
    );

    if (lockRes.rowCount === 0) {
      throw new HttpError(404, `Approval request #${approvalId} not found.`);
    }

    const approval = lockRes.rows[0];

    if (approval.status !== 'PENDING') {
      throw new HttpError(
        409,
        `Approval #${approvalId} is immutable and already ${approval.status}.`
      );
    }

    // Maker-checker invariant: requester can NEVER approve their own request
    if (Number(approval.requested_by) === Number(approverId)) {
      violationAudit = {
        action: 'MAKER_CHECKER_VIOLATION',
        entity: 'approvals',
        entityId: String(approvalId),
        payload: {
          attemptedAction: 'APPROVE',
          entityType: approval.entity_type,
          entityId: approval.entity_id,
          requestedBy: approval.requested_by,
          attemptedBy: approverId,
          attemptedByRole: approverRole,
        },
        statusCode: 403,
        message: 'Maker-checker violation: requester cannot approve their own request.',
      };
      await client.query('ROLLBACK');
    } else if (approverRole === 'ADMIN') {
      violationAudit = {
        action: 'ACCESS_DENIED_403',
        entity: 'approvals',
        entityId: String(approvalId),
        payload: {
          attemptedAction: 'APPROVE',
          entityType: approval.entity_type,
          reason: 'Admin is not permitted to approve PO changes or payments.',
        },
        statusCode: 403,
        message: 'Forbidden: Admin is not allowed to approve PO changes or payments.',
      };
      await client.query('ROLLBACK');
    } else if (
      (approval.entity_type === 'PO_PRICE_CHANGE' ||
        approval.entity_type === 'PAYMENT_APPROVAL' ||
        approval.entity_type === 'HIGH_RISK_ITEM') &&
      approverRole !== 'FINANCE_MANAGER'
    ) {
      violationAudit = {
        action: 'ACCESS_DENIED_403',
        entity: 'approvals',
        entityId: String(approvalId),
        payload: {
          attemptedAction: 'APPROVE',
          entityType: approval.entity_type,
          userRole: approverRole,
          requiredRole: 'FINANCE_MANAGER',
        },
        statusCode: 403,
        message: `Forbidden: Only Finance Manager can approve ${approval.entity_type}.`,
      };
      await client.query('ROLLBACK');
    } else {
      const updatedRes = await client.query<ApprovalRecord>(
        `
        UPDATE approvals
        SET status = 'APPROVED',
            approved_by = $1,
            decided_at = NOW(),
            remarks = COALESCE($2, remarks)
        WHERE id = $3
        RETURNING *;
        `,
        [approverId, remarks ?? null, approvalId]
      );

      const updated = updatedRes.rows[0];

      // Apply PO price change ONLY upon authorized approval
      if (approval.entity_type === 'PO_PRICE_CHANGE') {
        const payload = approval.payload || {};
        const poId = Number(payload.poId || approval.entity_id);
        const poLineId = Number(payload.poLineId);
        const newUnitPrice = Number(payload.newUnitPrice);
        const historyId = payload.historyId ? Number(payload.historyId) : null;

        if (!poLineId || Number.isNaN(newUnitPrice) || newUnitPrice <= 0) {
          throw new HttpError(400, 'Approval payload is missing valid PO line price details.');
        }

        await client.query(
          `
          UPDATE po_lines
          SET current_unit_price = $1
          WHERE id = $2 AND po_id = $3;
          `,
          [newUnitPrice, poLineId, poId]
        );

        await client.query(
          `
          UPDATE purchase_orders
          SET current_total = (
                SELECT COALESCE(SUM(current_quantity * current_unit_price), 0)
                FROM po_lines
                WHERE po_id = $1
              ),
              status = 'APPROVED_CHANGE',
              updated_at = NOW()
          WHERE id = $1;
          `,
          [poId]
        );

        if (historyId) {
          await client.query(
            `
            UPDATE po_change_history
            SET approval_id = $1,
                status = 'APPROVED'
            WHERE id = $2;
            `,
            [approvalId, historyId]
          );
        }

        await writeAuditLog(
          approverId,
          'PO_PRICE_CHANGE_APPLIED',
          'purchase_orders',
          poId,
          {
            approvalId,
            poLineId,
            historyId,
            oldUnitPrice: payload.oldUnitPrice,
            newUnitPrice,
          },
          client
        );
      }

      await writeAuditLog(
        approverId,
        'APPROVAL_APPROVED',
        'approvals',
        approvalId,
        {
          entityType: approval.entity_type,
          entityId: approval.entity_id,
          requestedBy: approval.requested_by,
          approvedBy: approverId,
          remarks: remarks ?? null,
        },
        client
      );

      await client.query('COMMIT');
      return updated;
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // Persist security/maker-checker violation outside the rolled-back transaction
  if (violationAudit) {
    await writeAuditLog(
      approverId,
      violationAudit.action,
      violationAudit.entity,
      violationAudit.entityId,
      violationAudit.payload
    );
    throw new HttpError(violationAudit.statusCode, violationAudit.message);
  }

  throw new HttpError(500, 'Unexpected approval state.');
}

export async function reject(
  approvalId: number,
  approverId: number,
  approverRole: UserRole,
  reason: string
): Promise<ApprovalRecord> {
  const pool = getPool();
  const client = await pool.connect();

  let violationAudit: {
    action: string;
    entity: string;
    entityId: string;
    payload: Record<string, unknown>;
    statusCode: number;
    message: string;
  } | null = null;

  try {
    await client.query('BEGIN');

    const lockRes = await client.query<ApprovalRecord>(
      'SELECT * FROM approvals WHERE id = $1 FOR UPDATE',
      [approvalId]
    );

    if (lockRes.rowCount === 0) {
      throw new HttpError(404, `Approval request #${approvalId} not found.`);
    }

    const approval = lockRes.rows[0];

    if (approval.status !== 'PENDING') {
      throw new HttpError(
        409,
        `Approval #${approvalId} is immutable and already ${approval.status}.`
      );
    }

    if (Number(approval.requested_by) === Number(approverId)) {
      violationAudit = {
        action: 'MAKER_CHECKER_VIOLATION',
        entity: 'approvals',
        entityId: String(approvalId),
        payload: {
          attemptedAction: 'REJECT',
          entityType: approval.entity_type,
          entityId: approval.entity_id,
          requestedBy: approval.requested_by,
          attemptedBy: approverId,
        },
        statusCode: 403,
        message: 'Maker-checker violation: requester cannot decide their own approval request.',
      };
      await client.query('ROLLBACK');
    } else if (approverRole === 'ADMIN') {
      violationAudit = {
        action: 'ACCESS_DENIED_403',
        entity: 'approvals',
        entityId: String(approvalId),
        payload: {
          attemptedAction: 'REJECT',
          entityType: approval.entity_type,
          reason: 'Admin is not permitted to decide PO or payment approvals.',
        },
        statusCode: 403,
        message: 'Forbidden: Admin is not allowed to approve or reject PO/payment requests.',
      };
      await client.query('ROLLBACK');
    } else if (
      (approval.entity_type === 'PO_PRICE_CHANGE' ||
        approval.entity_type === 'PAYMENT_APPROVAL' ||
        approval.entity_type === 'HIGH_RISK_ITEM') &&
      approverRole !== 'FINANCE_MANAGER'
    ) {
      violationAudit = {
        action: 'ACCESS_DENIED_403',
        entity: 'approvals',
        entityId: String(approvalId),
        payload: {
          attemptedAction: 'REJECT',
          entityType: approval.entity_type,
          userRole: approverRole,
          requiredRole: 'FINANCE_MANAGER',
        },
        statusCode: 403,
        message: `Forbidden: Only Finance Manager can reject ${approval.entity_type}.`,
      };
      await client.query('ROLLBACK');
    } else {
      const updatedRes = await client.query<ApprovalRecord>(
        `
        UPDATE approvals
        SET status = 'REJECTED',
            approved_by = $1,
            decided_at = NOW(),
            remarks = $2
        WHERE id = $3
        RETURNING *;
        `,
        [approverId, reason, approvalId]
      );

      const updated = updatedRes.rows[0];

      if (approval.entity_type === 'PO_PRICE_CHANGE' && approval.payload?.historyId) {
        await client.query(
          `
          UPDATE po_change_history
          SET approval_id = $1,
              status = 'REJECTED'
          WHERE id = $2;
          `,
          [approvalId, Number(approval.payload.historyId)]
        );
      }

      await writeAuditLog(
        approverId,
        'APPROVAL_REJECTED',
        'approvals',
        approvalId,
        {
          entityType: approval.entity_type,
          entityId: approval.entity_id,
          requestedBy: approval.requested_by,
          rejectedBy: approverId,
          reason,
        },
        client
      );

      await client.query('COMMIT');
      return updated;
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (violationAudit) {
    await writeAuditLog(
      approverId,
      violationAudit.action,
      violationAudit.entity,
      violationAudit.entityId,
      violationAudit.payload
    );
    throw new HttpError(violationAudit.statusCode, violationAudit.message);
  }

  throw new HttpError(500, 'Unexpected approval state.');
}
