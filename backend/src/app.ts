import cors from 'cors';
import express, { Express } from 'express';
import { env } from './config/env.ts';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts';
import { approvalsRouter } from './routes/approvals.ts';
import { auditLogRouter } from './routes/auditLog.ts';
import { authRouter } from './routes/auth.ts';
import { copilotRouter } from './routes/copilot.ts';
import { dashboardRouter } from './routes/dashboard.ts';
import { grnsRouter } from './routes/grns.ts';
import { healthRouter } from './routes/health.ts';
import { investigationsRouter } from './routes/investigations.ts';
import { invoicesRouter } from './routes/invoices.ts';
import { purchaseOrdersRouter } from './routes/purchaseOrders.ts';
import { suppliersRouter } from './routes/suppliers.ts';
import { systemRouter } from './routes/system.ts';

function resolveCorsOrigin(): cors.CorsOptions['origin'] {
  const rawOrigin = env.CORS_ORIGIN ? env.CORS_ORIGIN.trim() : '*';
  if (!rawOrigin || rawOrigin === '*') {
    // Reflect request origin so credentials (Authorization / Bearer tokens) are allowed
    return true;
  }

  const allowedList = rawOrigin
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return (origin, callback) => {
    // Allow non-browser requests (e.g. mobile apps, curl, server-side cron)
    if (!origin) {
      return callback(null, true);
    }

    const cleanOrigin = origin.trim().replace(/\/+$/, '');

    // Wildcard in allowed list or exact origin match
    if (allowedList.includes('*') || allowedList.includes(cleanOrigin)) {
      return callback(null, true);
    }

    // Always permit Vercel production and preview deployment domains (*.vercel.app)
    if (cleanOrigin.endsWith('.vercel.app') || cleanOrigin.includes('.vercel.app')) {
      return callback(null, true);
    }

    // Allow local development and test origins
    if (cleanOrigin.startsWith('http://localhost:') || cleanOrigin.startsWith('http://127.0.0.1:')) {
      return callback(null, true);
    }

    return callback(new Error(`CORS error: Origin ${origin} is not allowed.`));
  };
}

export function createApiApp(): Express {
  const app = express();

  const corsOptions: cors.CorsOptions = {
    origin: resolveCorsOrigin(),
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  };

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Public health & authentication routes
  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);

  // Protected workflow routes
  app.use('/api/approvals', approvalsRouter);
  app.use('/api/purchase-orders', purchaseOrdersRouter);
  app.use('/api/audit-log', auditLogRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/investigations', investigationsRouter);
  app.use('/api/copilot', copilotRouter);
  app.use('/api/grns', grnsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/suppliers', suppliersRouter);
  app.use('/api/system', systemRouter);

  return app;
}

export function attachApiErrorHandlers(app: Express): void {
  app.use('/api/*', notFoundHandler);
  app.use(errorHandler);
}
