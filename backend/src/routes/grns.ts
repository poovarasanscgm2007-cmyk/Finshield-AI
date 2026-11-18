import { NextFunction, Response, Router } from 'express';
import { ROLES } from '../auth/permissions.ts';
import { authenticate, AuthenticatedRequest, requireRole } from '../middleware/auth.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { ensureDatabaseBootstrapped } from '../services/bootstrapDb.ts';
import { createOrCorrectGrn, listGrns } from '../services/grnService.ts';

export const grnsRouter = Router();

grnsRouter.use(authenticate);

grnsRouter.get(
  '/',
  requireRole(...ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const items = await listGrns();
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  }
);

grnsRouter.post(
  '/',
  requireRole('WAREHOUSE_EMPLOYEE'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();

      const poId = req.body?.poId ? Number(req.body.poId) : undefined;
      const poNumber = typeof req.body?.poNumber === 'string' ? req.body.poNumber : undefined;
      const grnNumber = typeof req.body?.grnNumber === 'string' ? req.body.grnNumber : undefined;
      const quantityReceived = Number(req.body?.quantityReceived);
      const unit = typeof req.body?.unit === 'string' ? req.body.unit : 'kg';
      const warehouseLocation =
        typeof req.body?.warehouseLocation === 'string' ? req.body.warehouseLocation : undefined;
      const replacesGrnId = req.body?.replacesGrnId ? Number(req.body.replacesGrnId) : null;
      const isCorrection = Boolean(req.body?.isCorrection);

      if ((!poId && !poNumber) || Number.isNaN(quantityReceived) || quantityReceived <= 0) {
        throw new HttpError(400, 'poId or poNumber and a positive quantityReceived are required.');
      }

      const result = await createOrCorrectGrn({
        poId,
        poNumber,
        grnNumber,
        quantityReceived,
        unit,
        warehouseLocation,
        replacesGrnId,
        isCorrection,
        receivedBy: req.user!.id,
      });

      res.status(201).json({
        message: `GRN ${result.grn.grn_number} (${result.quantityReceived} ${unit}) recorded.`,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);
