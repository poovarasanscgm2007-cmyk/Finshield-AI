import { NextFunction, Response, Router } from 'express';
import { ROLES } from '../auth/permissions.ts';
import { authenticate, AuthenticatedRequest, requireRole } from '../middleware/auth.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { ensureDatabaseBootstrapped } from '../services/bootstrapDb.ts';
import {
  getAllSupplierScorecards,
  getSupplierRelationshipGraph,
  getSupplierScorecardById,
  requestSupplierBankChange,
} from '../services/supplierService.ts';

export const suppliersRouter = Router();

suppliersRouter.use(authenticate);

suppliersRouter.get(
  '/graph',
  requireRole(...ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const graph = await getSupplierRelationshipGraph();
      res.status(200).json(graph);
    } catch (err) {
      next(err);
    }
  }
);

suppliersRouter.get(
  '/scorecards',
  requireRole(...ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const data = await getAllSupplierScorecards();
      res.status(200).json(data);
    } catch (err) {
      next(err);
    }
  }
);

suppliersRouter.get(
  '/:id/scorecard',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const supplierId = Number(req.params.id);
      if (Number.isNaN(supplierId) || supplierId <= 0) {
        throw new HttpError(400, 'Invalid supplier ID.');
      }

      const scorecard = await getSupplierScorecardById(supplierId);
      res.status(200).json(scorecard);
    } catch (err) {
      next(err);
    }
  }
);

suppliersRouter.put(
  '/:id/bank',
  requireRole('PROCUREMENT_EMPLOYEE', 'AP_EMPLOYEE', 'FINANCE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const supplierId = Number(req.params.id);
      if (Number.isNaN(supplierId) || supplierId <= 0) {
        throw new HttpError(400, 'Invalid supplier ID.');
      }

      const newBankIdentifier =
        typeof req.body?.newBankIdentifier === 'string' ? req.body.newBankIdentifier : '';
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

      const result = await requestSupplierBankChange({
        supplierId,
        newBankIdentifier,
        reason,
        actorId: req.user!.id,
        actorRole: req.user!.role,
      });

      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  }
);
