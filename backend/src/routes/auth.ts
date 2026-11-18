import bcrypt from 'bcryptjs';
import { NextFunction, Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import { isValidRole } from '../auth/permissions.ts';
import { query } from '../db/pool.ts';
import { authenticate, AuthenticatedRequest, getJwtSecret } from '../middleware/auth.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { writeAuditLog } from '../services/auditService.ts';
import { ensureDatabaseBootstrapped } from '../services/bootstrapDb.ts';

export const authRouter = Router();

interface DbUserRow {
  id: number;
  employee_code: string;
  name: string;
  email: string;
  password_hash: string | null;
  role: string;
  department: string;
  is_active: boolean;
}

authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureDatabaseBootstrapped();

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      throw new HttpError(400, 'Email and password are required.');
    }

    const result = await query<DbUserRow>(
      `
      SELECT id, employee_code, name, email, password_hash, role, department, is_active
      FROM users
      WHERE LOWER(email) = $1
      LIMIT 1;
      `,
      [email]
    );

    const user = result.rows[0];

    if (!user || !user.is_active || !user.password_hash) {
      await writeAuditLog(null, 'LOGIN_FAILURE', 'auth', email, {
        email,
        reason: 'User not found or inactive',
      });
      throw new HttpError(401, 'Invalid email or password.');
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      await writeAuditLog(user.id, 'LOGIN_FAILURE', 'auth', user.id, {
        email,
        reason: 'Invalid password',
      });
      throw new HttpError(401, 'Invalid email or password.');
    }

    if (!isValidRole(user.role)) {
      throw new HttpError(500, 'User has invalid role configuration.');
    }

    const token = jwt.sign(
      {
        sub: String(user.id),
        employeeCode: user.employee_code,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
      },
      getJwtSecret(),
      { expiresIn: '8h' }
    );

    await writeAuditLog(user.id, 'LOGIN_SUCCESS', 'auth', user.id, {
      email: user.email,
      role: user.role,
    });

    res.status(200).json({
      token,
      expiresIn: '8h',
      user: {
        id: user.id,
        employeeCode: user.employee_code,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await ensureDatabaseBootstrapped();

    const userRes = await query<DbUserRow>(
      `
      SELECT id, employee_code, name, email, role, department, is_active
      FROM users
      WHERE id = $1
      LIMIT 1;
      `,
      [req.user!.id]
    );

    const user = userRes.rows[0];
    if (!user || !user.is_active) {
      throw new HttpError(401, 'User account is inactive or no longer exists.');
    }

    res.status(200).json({
      user: {
        id: user.id,
        employeeCode: user.employee_code,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
      },
    });
  } catch (err) {
    next(err);
  }
});
