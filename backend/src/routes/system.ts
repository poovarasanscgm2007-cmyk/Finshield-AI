import { NextFunction, Response, Router } from 'express';
import { runMigrations } from '../../../database/migrate.ts';
import { seedDatabase } from '../../../database/seed.ts';
import { getPool } from '../db/pool.ts';
import { authenticate, AuthenticatedRequest, requireRole } from '../middleware/auth.ts';
import { syncAndEvaluateInvoice } from '../services/investigationService.ts';
import { syncSupplierGraphRisks } from '../services/supplierService.ts';

export const systemRouter = Router();

systemRouter.use(authenticate);

export async function performDemoReset(): Promise<{
  evaluatedInvoices: number[];
}> {
  const pool = getPool();
  await runMigrations(pool);
  await seedDatabase(pool);

  const invRes = await pool.query<{ id: number }>(
    `
    SELECT id
    FROM invoices
    WHERE is_historical = FALSE
      AND invoice_number IN ('INV-101', 'INV_101')
    ORDER BY id ASC;
    `
  );

  const evaluatedInvoices: number[] = [];
  for (const row of invRes.rows) {
    await syncAndEvaluateInvoice(row.id, null);
    evaluatedInvoices.push(row.id);
  }

  await syncSupplierGraphRisks();

  return { evaluatedInvoices };
}

systemRouter.post(
  '/reset-demo',
  requireRole('ADMIN', 'FINANCE_MANAGER'),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await performDemoReset();
      res.status(200).json({
        message: 'Demo database restored to original sample seed state with PO-101 unapproved change intact.',
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);
