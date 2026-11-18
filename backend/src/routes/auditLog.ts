import { NextFunction, Response, Router } from 'express';
import { authenticate, AuthenticatedRequest, requireRole } from '../middleware/auth.ts';
import { listAuditLogs, verifyAuditChain } from '../services/auditService.ts';
import { ensureDatabaseBootstrapped } from '../services/bootstrapDb.ts';

export const auditLogRouter = Router();

auditLogRouter.use(authenticate);
auditLogRouter.use(requireRole('ADMIN', 'FINANCE_MANAGER'));

auditLogRouter.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await ensureDatabaseBootstrapped();

    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    const action = typeof req.query.action === 'string' && req.query.action.trim() ? req.query.action.trim() : undefined;
    const entity = typeof req.query.entity === 'string' && req.query.entity.trim() ? req.query.entity.trim() : undefined;
    const actorId = req.query.actorId ? Number(req.query.actorId) : undefined;

    const result = await listAuditLogs({ page, limit, action, entity, actorId });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

auditLogRouter.get('/verify', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await ensureDatabaseBootstrapped();
    const result = await verifyAuditChain();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
