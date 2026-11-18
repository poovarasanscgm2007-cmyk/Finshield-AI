import { NextFunction, Response, Router } from 'express';
import { ROLES } from '../auth/permissions.ts';
import { authenticate, AuthenticatedRequest, requireRole } from '../middleware/auth.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { ensureDatabaseBootstrapped } from '../services/bootstrapDb.ts';
import { askCopilot } from '../services/copilotService.ts';

export const copilotRouter = Router();

copilotRouter.use(authenticate);

copilotRouter.post(
  '/ask',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();

      const question = typeof req.body?.question === 'string' ? req.body.question : '';
      const rawInvoiceId = req.body?.invoiceId;
      const invoiceId =
        rawInvoiceId !== undefined && rawInvoiceId !== null && rawInvoiceId !== ''
          ? Number(rawInvoiceId)
          : undefined;

      if (invoiceId !== undefined && (Number.isNaN(invoiceId) || invoiceId <= 0)) {
        throw new HttpError(400, 'invoiceId must be a valid positive integer.');
      }

      const result = await askCopilot({
        question,
        invoiceId,
        actorId: req.user!.id,
        actorRole: req.user!.role,
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);
