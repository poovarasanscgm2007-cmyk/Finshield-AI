import { NextFunction, Response, Router } from 'express';
import { getPool, query } from '../db/pool.ts';
import { authenticate, AuthenticatedRequest, requireRole } from '../middleware/auth.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { writeAuditLog } from '../services/auditService.ts';
import { ensureDatabaseBootstrapped } from '../services/bootstrapDb.ts';

export const purchaseOrdersRouter = Router();

purchaseOrdersRouter.use(authenticate);

purchaseOrdersRouter.get(
  '/',
  requireRole('PROCUREMENT_EMPLOYEE', 'FINANCE_MANAGER', 'ADMIN', 'AP_EMPLOYEE'),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();

      const posRes = await query(`
        SELECT
          po.*,
          s.name AS supplier_name,
          s.supplier_code,
          s.gstin AS supplier_gstin
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        ORDER BY po.id ASC;
      `);

      const linesRes = await query(`
        SELECT * FROM po_lines ORDER BY po_id ASC, line_number ASC;
      `);

      const historyRes = await query(`
        SELECT
          pch.*,
          u.name AS changed_by_name,
          u.role AS changed_by_role,
          a.status AS approval_status
        FROM po_change_history pch
        JOIN users u ON u.id = pch.changed_by
        LEFT JOIN approvals a ON a.id = pch.approval_id
        ORDER BY pch.id DESC;
      `);

      res.status(200).json({
        purchaseOrders: posRes.rows,
        lines: linesRes.rows,
        changeHistory: historyRes.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

purchaseOrdersRouter.get(
  '/unapproved-changes',
  requireRole('PROCUREMENT_EMPLOYEE', 'FINANCE_MANAGER', 'ADMIN'),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();

      const unapprovedRes = await query(`
        SELECT
          pch.*,
          po.po_number,
          u.name AS changed_by_name,
          u.employee_code AS changed_by_code
        FROM po_change_history pch
        JOIN purchase_orders po ON po.id = pch.po_id
        JOIN users u ON u.id = pch.changed_by
        WHERE pch.approval_id IS NULL OR pch.status = 'UNAPPROVED'
        ORDER BY pch.changed_at DESC;
      `);

      res.status(200).json({ items: unapprovedRes.rows });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/purchase-orders/:id/price
 * Creates a pending po_change_history row + approval request instead of mutating PO price directly.
 * Price is applied ONLY after Finance Manager approves (maker-checker enforced).
 */
purchaseOrdersRouter.put(
  '/:id/price',
  requireRole('PROCUREMENT_EMPLOYEE'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();

      const poId = Number(req.params.id);
      const newUnitPrice = Number(req.body?.newUnitPrice);
      const requestedLineId = req.body?.lineId ? Number(req.body.lineId) : undefined;
      const reason =
        typeof req.body?.reason === 'string' && req.body.reason.trim()
          ? req.body.reason.trim()
          : 'PO unit price modification request';

      if (Number.isNaN(poId) || poId <= 0) {
        throw new HttpError(400, 'Invalid purchase order ID.');
      }
      if (Number.isNaN(newUnitPrice) || newUnitPrice <= 0) {
        throw new HttpError(400, 'newUnitPrice must be a positive number.');
      }

      const pool = getPool();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const poRes = await client.query<{ id: number; po_number: string }>(
          'SELECT id, po_number FROM purchase_orders WHERE id = $1 FOR UPDATE',
          [poId]
        );
        if (poRes.rowCount === 0) {
          throw new HttpError(404, `Purchase order #${poId} not found.`);
        }
        const po = poRes.rows[0];

        const lineRes = await client.query<{
          id: number;
          current_unit_price: string;
          current_quantity: string;
          description: string;
        }>(
          requestedLineId
            ? 'SELECT id, current_unit_price, current_quantity, description FROM po_lines WHERE po_id = $1 AND id = $2 LIMIT 1'
            : 'SELECT id, current_unit_price, current_quantity, description FROM po_lines WHERE po_id = $1 ORDER BY line_number ASC LIMIT 1',
          requestedLineId ? [poId, requestedLineId] : [poId]
        );

        if (lineRes.rowCount === 0) {
          throw new HttpError(404, `No PO line found for purchase order #${poId}.`);
        }

        const line = lineRes.rows[0];
        const oldUnitPrice = Number(line.current_unit_price);

        const historyRes = await client.query<{ id: number }>(
          `
          INSERT INTO po_change_history (
            po_id, po_line_id, changed_by, field, old_value, new_value, approval_id, status, reason, is_sample_data
          )
          VALUES ($1, $2, $3, 'unit_price', $4, $5, NULL, 'PENDING', $6, TRUE)
          RETURNING id;
          `,
          [poId, line.id, req.user!.id, oldUnitPrice.toFixed(2), newUnitPrice.toFixed(2), reason]
        );
        const historyId = historyRes.rows[0].id;

        const approvalPayload = {
          poId,
          poNumber: po.po_number,
          poLineId: line.id,
          lineDescription: line.description,
          historyId,
          oldUnitPrice,
          newUnitPrice,
          quantity: Number(line.current_quantity),
          reason,
        };

        const approvalRes = await client.query(
          `
          INSERT INTO approvals (
            entity_type, entity_id, approval_level, requested_by, status, remarks, payload, is_sample_data
          )
          VALUES ('PO_PRICE_CHANGE', $1, 1, $2, 'PENDING', $3, $4::jsonb, TRUE)
          RETURNING *;
          `,
          [poId, req.user!.id, reason, JSON.stringify(approvalPayload)]
        );
        const approval = approvalRes.rows[0];

        await client.query(
          'UPDATE po_change_history SET approval_id = $1 WHERE id = $2',
          [approval.id, historyId]
        );

        await writeAuditLog(
          req.user!.id,
          'PO_PRICE_CHANGE_REQUESTED',
          'purchase_orders',
          poId,
          {
            poNumber: po.po_number,
            poLineId: line.id,
            historyId,
            approvalId: approval.id,
            oldUnitPrice,
            newUnitPrice,
            reason,
          },
          client
        );

        await client.query('COMMIT');

        res.status(202).json({
          message: `Price change for ${po.po_number} (${oldUnitPrice} -> ${newUnitPrice}) submitted for Finance Manager approval. PO price was NOT changed directly.`,
          approval,
          changeHistoryId: historyId,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);
