import cors from 'cors';
import express, { Express } from 'express';
import { env } from './config/env.ts';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts';
import { approvalsRouter } from './routes/approvals.ts';
import { auditLogRouter } from './routes/auditLog.ts';
import { authRouter } from './routes/auth.ts';
import { healthRouter } from './routes/health.ts';
import { purchaseOrdersRouter } from './routes/purchaseOrders.ts';

export function createApiApp(): Express {
  const app = express();

  app.use(
    cors({
      origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Public health & authentication routes
  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);

  // Protected Phase 2 FINSHIELD GUARD routes
  app.use('/api/approvals', approvalsRouter);
  app.use('/api/purchase-orders', purchaseOrdersRouter);
  app.use('/api/audit-log', auditLogRouter);

  return app;
}

export function attachApiErrorHandlers(app: Express): void {
  app.use('/api/*', notFoundHandler);
  app.use(errorHandler);
}
