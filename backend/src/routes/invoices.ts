import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { ROLES } from '../auth/permissions.ts';
import { env } from '../config/env.ts';
import { authenticate, AuthenticatedRequest, requireRole } from '../middleware/auth.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { ensureDatabaseBootstrapped } from '../services/bootstrapDb.ts';
import { detectDuplicatesForInvoice } from '../services/duplicateService.ts';
import {
  createAndExtractInvoice,
  getInvoiceById,
  getInvoiceSummaryMetrics,
  listInvoices,
  resolveStoredInvoiceFile,
  verifyInvoice,
} from '../services/invoiceService.ts';
import {
  approveInvoicePayment,
  listInvestigations,
  syncAndEvaluateInvoice,
} from '../services/investigationService.ts';
import { getLatestMatchResult, matchInvoice } from '../services/matchingService.ts';
import { getInvoiceRiskSummary } from '../services/riskPipelineService.ts';

export const invoicesRouter = Router();

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
]);

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mimeOk = ALLOWED_MIME_TYPES.has(file.mimetype);
    const extOk = ALLOWED_EXTENSIONS.has(ext);
    if (!mimeOk || !extOk) {
      cb(new HttpError(400, 'Invalid file type. Only PDF, PNG, and JPG files up to 10 MB are allowed.'));
      return;
    }
    cb(null, true);
  },
});

function handleUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(new HttpError(400, 'File exceeds maximum allowed size of 10 MB.'));
        return;
      }
      next(new HttpError(400, `Upload error: ${err.message}`));
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

invoicesRouter.use(authenticate);

invoicesRouter.post(
  '/upload',
  requireRole('AP_EMPLOYEE'),
  handleUploadMiddleware,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();

      const file = req.file;
      if (!file) {
        throw new HttpError(400, 'No invoice file provided. Upload a PDF, PNG, or JPG in field "file".');
      }

      const invoicesDir = path.join(env.UPLOAD_DIR, 'invoices');
      fs.mkdirSync(invoicesDir, { recursive: true });

      const sanitizedBase = path
        .basename(file.originalname)
        .replace(/[^a-zA-Z0-9._-]/g, '_');
      const storedFilename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitizedBase}`;
      const absolutePath = path.join(invoicesDir, storedFilename);
      fs.writeFileSync(absolutePath, file.buffer);

      const relativePath = path.relative(path.resolve(env.UPLOAD_DIR, '..'), absolutePath);

      const result = await createAndExtractInvoice({
        fileBuffer: file.buffer,
        originalFilename: file.originalname,
        mimeType: file.mimetype === 'image/jpg' ? 'image/jpeg' : file.mimetype,
        fileSize: file.size,
        storedRelativePath: relativePath,
        uploadedBy: req.user!.id,
      });

      res.status(201).json({
        message: `Invoice uploaded and processed (${result.invoice.status}).`,
        invoice: result.invoice,
        lines: result.lines,
        extraction: {
          status: result.extraction.status,
          extractionSource: result.extraction.extractionSource,
          extractionMethod: result.extraction.extractionMethod,
          ocrConfidence: result.extraction.ocrConfidence,
          threshold: result.extraction.threshold,
          fields: result.extraction.fields,
          extractionConfidence: result.extraction.extractionConfidence,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

invoicesRouter.get(
  '/',
  requireRole(...ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const items = await listInvoices();
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  }
);

invoicesRouter.get(
  '/summary',
  requireRole(...ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const summary = await getInvoiceSummaryMetrics();
      res.status(200).json(summary);
    } catch (err) {
      next(err);
    }
  }
);

invoicesRouter.get(
  '/:id',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid invoice ID.');
      }

      const data = await getInvoiceById(id);
      const resolvedFile = resolveStoredInvoiceFile(data.invoice.file_path);

      res.status(200).json({
        ...data,
        hasFile: Boolean(resolvedFile),
        fileUrl: resolvedFile ? `/api/invoices/${id}/file` : null,
      });
    } catch (err) {
      next(err);
    }
  }
);

invoicesRouter.get(
  '/:id/file',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid invoice ID.');
      }

      const { invoice } = await getInvoiceById(id);
      const resolvedPath = resolveStoredInvoiceFile(invoice.file_path);
      if (!resolvedPath) {
        throw new HttpError(404, 'Invoice document file is not available on disk.');
      }

      const ext = path.extname(resolvedPath).toLowerCase();
      const mimeType =
        invoice.mime_type ||
        (ext === '.pdf'
          ? 'application/pdf'
          : ext === '.png'
          ? 'image/png'
          : 'image/jpeg');

      res.setHeader('Content-Type', mimeType);
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${invoice.original_filename || path.basename(resolvedPath)}"`
      );
      res.sendFile(resolvedPath);
    } catch (err) {
      next(err);
    }
  }
);

invoicesRouter.put(
  '/:id/verify',
  requireRole('AP_EMPLOYEE'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid invoice ID.');
      }

      const result = await verifyInvoice(id, req.user!.id, req.body || {});
      res.status(200).json({
        message: `Invoice #${id} verified and 3-way matched (${result.matchResult.status}).`,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

invoicesRouter.post(
  '/:id/match',
  requireRole('AP_EMPLOYEE', 'FINANCE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid invoice ID.');
      }

      const result = await matchInvoice(id, req.user!.id);
      res.status(200).json({
        message: `3-way matching completed for Invoice #${id}: ${result.matchResult.status}.`,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

invoicesRouter.get(
  '/:id/match-result',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid invoice ID.');
      }

      const matchResult = await getLatestMatchResult(id);
      res.status(200).json({
        invoiceId: id,
        hasMatchResult: Boolean(matchResult),
        matchResult,
      });
    } catch (err) {
      next(err);
    }
  }
);

invoicesRouter.get(
  '/:id/duplicates',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid invoice ID.');
      }

      const duplicates = await detectDuplicatesForInvoice(id);
      res.status(200).json(duplicates);
    } catch (err) {
      next(err);
    }
  }
);

invoicesRouter.get(
  '/:id/investigations',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid invoice ID.');
      }

      const [riskSummary, investigations] = await Promise.all([
        getInvoiceRiskSummary(id),
        listInvestigations({ invoiceId: id }),
      ]);

      res.status(200).json({
        invoiceId: id,
        riskSummary,
        investigations,
      });
    } catch (err) {
      next(err);
    }
  }
);

invoicesRouter.post(
  '/:id/run-pipeline',
  requireRole('AP_EMPLOYEE', 'FINANCE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid invoice ID.');
      }

      const result = await syncAndEvaluateInvoice(id, req.user!.id);
      res.status(200).json({
        message: `Full risk & compliance pipeline executed for Invoice #${id}.`,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

invoicesRouter.post(
  '/:id/approve-payment',
  requireRole('AP_EMPLOYEE', 'PROCUREMENT_EMPLOYEE', 'WAREHOUSE_EMPLOYEE', 'FINANCE_MANAGER', 'ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid invoice ID.');
      }

      const rawLevel = req.body?.level !== undefined ? Number(req.body.level) : 2;
      const level: 1 | 2 = rawLevel === 1 ? 1 : 2;
      const remarks = typeof req.body?.remarks === 'string' ? req.body.remarks : undefined;

      const result = await approveInvoicePayment({
        invoiceId: id,
        approverId: req.user!.id,
        approverRole: req.user!.role,
        level,
        remarks,
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);
