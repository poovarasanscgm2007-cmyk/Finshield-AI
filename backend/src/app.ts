import cors from 'cors';
import express, { Express } from 'express';
import { env } from './config/env.ts';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts';
import { healthRouter } from './routes/health.ts';

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

  app.use('/api/health', healthRouter);

  return app;
}

export function attachApiErrorHandlers(app: Express): void {
  app.use('/api/*', notFoundHandler);
  app.use(errorHandler);
}
