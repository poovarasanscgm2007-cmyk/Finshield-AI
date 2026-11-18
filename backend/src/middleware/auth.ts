import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { isValidRole, UserRole } from '../auth/permissions.ts';
import { env } from '../config/env.ts';
import { writeAuditLog } from '../services/auditService.ts';

export interface AuthenticatedUser {
  id: number;
  employeeCode: string;
  name: string;
  email: string;
  role: UserRole;
  department: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

export function getJwtSecret(): string {
  return env.JWT_SECRET || 'finshield-ai-dev-jwt-secret-change-me';
}

export function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required. Missing Bearer token.',
    });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required. Empty Bearer token.',
    });
    return;
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
    const role = String(decoded.role || '');

    if (!decoded.sub || !isValidRole(role)) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token claims.',
      });
      return;
    }

    req.user = {
      id: Number(decoded.sub),
      employeeCode: String(decoded.employeeCode || ''),
      name: String(decoded.name || ''),
      email: String(decoded.email || ''),
      role,
      department: String(decoded.department || ''),
    };
    next();
  } catch {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired authentication token.',
    });
  }
}

export function requireRole(...allowedRoles: UserRole[]) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required.',
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      try {
        await writeAuditLog(req.user.id, 'ACCESS_DENIED_403', 'ROUTE', req.originalUrl, {
          method: req.method,
          path: req.originalUrl,
          userRole: req.user.role,
          requiredRoles: allowedRoles,
        });
      } catch (auditErr) {
        console.error('Failed to write ACCESS_DENIED_403 audit log:', auditErr);
      }

      res.status(403).json({
        error: 'Forbidden',
        message: `Access denied for role ${req.user.role}. Allowed roles: ${allowedRoles.join(', ')}.`,
      });
      return;
    }

    next();
  };
}
