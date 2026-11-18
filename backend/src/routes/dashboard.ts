import { NextFunction, Response, Router } from 'express';
import { ROLES } from '../auth/permissions.ts';
import { authenticate, AuthenticatedRequest, requireRole } from '../middleware/auth.ts';
import { ensureDatabaseBootstrapped } from '../services/bootstrapDb.ts';
import { getDashboardMetrics } from '../services/dashboardService.ts';

export const dashboardRouter = Router();

dashboardRouter.use(authenticate);

dashboardRouter.get(
  '/metrics',
  requireRole(...ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const metrics = await getDashboardMetrics();
      res.status(200).json(metrics);
    } catch (err) {
      next(err);
    }
  }
);
