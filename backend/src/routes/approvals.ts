import { NextFunction, Response, Router } from 'express';
import { ROLES } from '../auth/permissions.ts';
import { authenticate, AuthenticatedRequest, requireRole } from '../middleware/auth.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import {
  approve,
  createApprovalRequest,
  listApprovalsByRole,
  reject,
} from '../services/approvalService.ts';
import { ensureDatabaseBootstrapped } from '../services/bootstrapDb.ts';

export const approvalsRouter = Router();

approvalsRouter.use(authenticate);

approvalsRouter.get(
  '/',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const statusFilter = typeof req.query.status === 'string' ? req.query.status : undefined;
      const items = await listApprovalsByRole(req.user!.id, req.user!.role, statusFilter);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  }
);

approvalsRouter.post(
  '/',
  requireRole('AP_EMPLOYEE', 'PROCUREMENT_EMPLOYEE', 'WAREHOUSE_EMPLOYEE', 'FINANCE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const entityType = typeof req.body?.entityType === 'string' ? req.body.entityType.trim() : '';
      const entityId = Number(req.body?.entityId);
      const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
      const remarks = typeof req.body?.remarks === 'string' ? req.body.remarks.trim() : undefined;
      const approvalLevel = req.body?.approvalLevel ? Number(req.body.approvalLevel) : 1;

      if (!entityType || Number.isNaN(entityId) || entityId <= 0) {
        throw new HttpError(400, 'Valid entityType and positive numeric entityId are required.');
      }

      const approval = await createApprovalRequest(
        entityType,
        entityId,
        req.user!.id,
        payload,
        remarks,
        approvalLevel
      );

      res.status(201).json({ approval });
    } catch (err) {
      next(err);
    }
  }
);

approvalsRouter.post(
  '/:id/approve',
  requireRole('FINANCE_MANAGER', 'PROCUREMENT_EMPLOYEE', 'AP_EMPLOYEE', 'WAREHOUSE_EMPLOYEE', 'ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const approvalId = Number(req.params.id);
      if (Number.isNaN(approvalId) || approvalId <= 0) {
        throw new HttpError(400, 'Invalid approval ID.');
      }

      const remarks = typeof req.body?.remarks === 'string' ? req.body.remarks.trim() : undefined;
      const approval = await approve(approvalId, req.user!.id, req.user!.role, remarks);
      res.status(200).json({
        message: `Approval #${approvalId} approved successfully.`,
        approval,
      });
    } catch (err) {
      next(err);
    }
  }
);

approvalsRouter.post(
  '/:id/reject',
  requireRole('FINANCE_MANAGER', 'PROCUREMENT_EMPLOYEE', 'AP_EMPLOYEE', 'WAREHOUSE_EMPLOYEE', 'ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const approvalId = Number(req.params.id);
      if (Number.isNaN(approvalId) || approvalId <= 0) {
        throw new HttpError(400, 'Invalid approval ID.');
      }

      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (!reason) {
        throw new HttpError(400, 'A rejection reason is required.');
      }

      const approval = await reject(approvalId, req.user!.id, req.user!.role, reason);
      res.status(200).json({
        message: `Approval #${approvalId} rejected.`,
        approval,
      });
    } catch (err) {
      next(err);
    }
  }
);
