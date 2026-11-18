import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { ROLES } from '../auth/permissions.ts';
import { env } from '../config/env.ts';
import { query } from '../db/pool.ts';
import { authenticate, AuthenticatedRequest, requireRole } from '../middleware/auth.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { ensureDatabaseBootstrapped } from '../services/bootstrapDb.ts';
import {
  addInvestigationComment,
  addInvestigationEvidence,
  getInvestigationDetail,
  listInvestigations,
  reassignInvestigation,
  transitionInvestigationStatus,
} from '../services/investigationService.ts';

export const investigationsRouter = Router();

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'text/plain',
  'text/csv',
]);

const uploadEvidence = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(
        new HttpError(
          400,
          'Invalid evidence file type. Allowed: PDF, PNG, JPG, TXT, CSV up to 10 MB.'
        )
      );
      return;
    }
    cb(null, true);
  },
});

function optionalFileUpload(req: Request, res: Response, next: NextFunction): void {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    uploadEvidence.single('file')(req, res, (err: unknown) => {
      if (err) {
        next(err);
        return;
      }
      next();
    });
    return;
  }
  next();
}

investigationsRouter.use(authenticate);

investigationsRouter.get(
  '/',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();

      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const department =
        typeof req.query.department === 'string' ? req.query.department : undefined;
      const assignee = typeof req.query.assignee === 'string' ? req.query.assignee : undefined;
      const invoiceId =
        typeof req.query.invoiceId === 'string' && req.query.invoiceId
          ? Number(req.query.invoiceId)
          : undefined;

      const items = await listInvestigations({ status, department, assignee, invoiceId });
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  }
);

investigationsRouter.get(
  '/:id',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid investigation ID.');
      }

      const detail = await getInvestigationDetail(id);
      res.status(200).json(detail);
    } catch (err) {
      next(err);
    }
  }
);

investigationsRouter.put(
  '/:id/status',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid investigation ID.');
      }

      const rawStatus =
        typeof req.body?.status === 'string' ? req.body.status.trim().toUpperCase() : '';
      if (rawStatus !== 'IN_PROGRESS' && rawStatus !== 'RESOLVED') {
        throw new HttpError(400, 'status must be IN_PROGRESS or RESOLVED.');
      }

      const comment = typeof req.body?.comment === 'string' ? req.body.comment : '';
      const result = await transitionInvestigationStatus({
        investigationId: id,
        actorId: req.user!.id,
        actorRole: req.user!.role,
        targetStatus: rawStatus,
        comment,
      });

      res.status(200).json({
        message:
          rawStatus === 'RESOLVED'
            ? `Investigation #${id} revalidation outcome: ${result.revalidation.outcome}.`
            : `Investigation #${id} moved to IN_PROGRESS.`,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

investigationsRouter.put(
  '/:id/assign',
  requireRole('FINANCE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      const assignedTo = Number(req.body?.assignedTo);
      const comment = typeof req.body?.comment === 'string' ? req.body.comment : undefined;

      if (Number.isNaN(id) || id <= 0 || Number.isNaN(assignedTo) || assignedTo <= 0) {
        throw new HttpError(400, 'Valid investigation ID and assignedTo user ID are required.');
      }

      const updated = await reassignInvestigation({
        investigationId: id,
        actorId: req.user!.id,
        actorRole: req.user!.role,
        assignedTo,
        comment,
      });

      res.status(200).json({
        message: `Investigation #${id} reassigned.`,
        investigation: updated,
      });
    } catch (err) {
      next(err);
    }
  }
);

investigationsRouter.post(
  '/:id/comments',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid investigation ID.');
      }

      const comment = typeof req.body?.comment === 'string' ? req.body.comment : '';
      const created = await addInvestigationComment({
        investigationId: id,
        actorId: req.user!.id,
        actorRole: req.user!.role,
        comment,
      });

      res.status(201).json({ comment: created });
    } catch (err) {
      next(err);
    }
  }
);

investigationsRouter.post(
  '/:id/evidence',
  requireRole(...ROLES),
  optionalFileUpload,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      if (Number.isNaN(id) || id <= 0) {
        throw new HttpError(400, 'Invalid investigation ID.');
      }

      const file = req.file;
      const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
      const linkedEntityType =
        typeof req.body?.linkedEntityType === 'string' ? req.body.linkedEntityType.trim() : null;
      const linkedEntityId =
        typeof req.body?.linkedEntityId === 'string' ? req.body.linkedEntityId.trim() : null;

      if (!file && !note && !linkedEntityId) {
        throw new HttpError(400, 'Provide an evidence file, a note, or a linked record reference.');
      }

      let storedRelPath: string | null = null;
      if (file) {
        const evDir = path.join(env.UPLOAD_DIR, 'evidence');
        fs.mkdirSync(evDir, { recursive: true });
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;
        const absPath = path.join(evDir, filename);
        fs.writeFileSync(absPath, file.buffer);
        storedRelPath = path.relative(path.resolve(env.UPLOAD_DIR, '..'), absPath);
      }

      const evidenceType = file ? 'FILE' : linkedEntityId ? 'RECORD_LINK' : 'NOTE';

      const created = await addInvestigationEvidence({
        investigationId: id,
        actorId: req.user!.id,
        actorRole: req.user!.role,
        evidenceType,
        note: note || null,
        filePath: storedRelPath,
        originalFilename: file?.originalname ?? null,
        mimeType: file?.mimetype ?? null,
        fileSizeBytes: file?.size ?? null,
        linkedEntityType,
        linkedEntityId,
      });

      res.status(201).json({
        message: 'Evidence attached to investigation.',
        evidence: created,
      });
    } catch (err) {
      next(err);
    }
  }
);

investigationsRouter.get(
  '/:id/evidence/:evidenceId/file',
  requireRole(...ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await ensureDatabaseBootstrapped();
      const id = Number(req.params.id);
      const evidenceId = Number(req.params.evidenceId);
      if (Number.isNaN(id) || Number.isNaN(evidenceId)) {
        throw new HttpError(400, 'Invalid evidence identifiers.');
      }

      const evRes = await query<{
        file_path: string | null;
        original_filename: string | null;
        mime_type: string | null;
      }>(
        'SELECT file_path, original_filename, mime_type FROM investigation_evidence WHERE id = $1 AND investigation_id = $2 LIMIT 1',
        [evidenceId, id]
      );

      const ev = evRes.rows[0];
      if (!ev || !ev.file_path) {
        throw new HttpError(404, 'Evidence file not found.');
      }

      const projectRoot = path.resolve(env.UPLOAD_DIR, '..');
      const absPath = path.isAbsolute(ev.file_path)
        ? ev.file_path
        : path.resolve(projectRoot, ev.file_path);

      if (!fs.existsSync(absPath)) {
        throw new HttpError(404, 'Evidence file missing from disk.');
      }

      res.setHeader('Content-Type', ev.mime_type || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${ev.original_filename || path.basename(absPath)}"`
      );
      res.sendFile(absPath);
    } catch (err) {
      next(err);
    }
  }
);
