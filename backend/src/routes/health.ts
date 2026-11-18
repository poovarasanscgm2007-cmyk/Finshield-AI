import { NextFunction, Request, Response, Router } from 'express';
import { checkDatabaseHealth } from '../db/pool.ts';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const database = await checkDatabaseHealth();
    res.status(200).json({
      status: 'ok',
      service: 'finshield-ai-backend',
      phase: 'Phase 3 - Invoice Upload, OCR/AI Extraction & Human Verification',
      timestamp: new Date().toISOString(),
      database,
    });
  } catch (error) {
    next(error);
  }
});
