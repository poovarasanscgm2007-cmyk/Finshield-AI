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

async function executeLogin(
  emailInput: string,
  passwordInput: string,
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const email = emailInput.trim().toLowerCase();
  const password = passwordInput;

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
}

// POST /api/auth/login - Primary standard login route
authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureDatabaseBootstrapped();

    const email =
      typeof req.body?.email === 'string'
        ? req.body.email
        : typeof req.query?.email === 'string'
          ? req.query.email
          : '';
    const password =
      typeof req.body?.password === 'string'
        ? req.body.password
        : typeof req.query?.password === 'string'
          ? req.query.password
          : '';

    await executeLogin(email, password, req, res, next);
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/login - Handles cases where a client or proxy redirect accesses /login with GET
authRouter.get('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureDatabaseBootstrapped();

    const email =
      typeof req.query?.email === 'string'
        ? req.query.email
        : typeof req.body?.email === 'string'
          ? req.body.email
          : '';
    const password =
      typeof req.query?.password === 'string'
        ? req.query.password
        : typeof req.body?.password === 'string'
          ? req.body.password
          : '';

    // If credentials were provided via query parameters, process login
    if (email && password) {
      return await executeLogin(email, password, req, res, next);
    }

    // If an Authorization Bearer header is already present, return current session
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authenticate(req as AuthenticatedRequest, res, async () => {
        const userRes = await query<DbUserRow>(
          `
          SELECT id, employee_code, name, email, role, department, is_active
          FROM users
          WHERE id = $1
          LIMIT 1;
          `,
          [(req as AuthenticatedRequest).user!.id]
        );
        const u = userRes.rows[0];
        if (!u || !u.is_active) {
          throw new HttpError(401, 'User account is inactive or no longer exists.');
        }
        res.status(200).json({
          authenticated: true,
          user: {
            id: u.id,
            employeeCode: u.employee_code,
            name: u.name,
            email: u.email,
            role: u.role,
            department: u.department,
          },
        });
      });
    }

    // Clarify expected method without throwing 404
    res.status(405).json({
      error: 'Method Not Allowed',
      message: 'Login requires HTTP POST with JSON body containing email and password.',
      allowedMethods: ['POST'],
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/register - Register new organization user
authRouter.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureDatabaseBootstrapped();

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const requestedRole = typeof req.body?.role === 'string' ? req.body.role.trim() : 'AP_EMPLOYEE';
    const department = typeof req.body?.department === 'string' ? req.body.department.trim() : 'Accounts Payable';

    if (!email || !password) {
      throw new HttpError(400, 'Email and password are required for registration.');
    }

    if (password.length < 6) {
      throw new HttpError(400, 'Password must be at least 6 characters long.');
    }

    const existing = await query<DbUserRow>(
      'SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1;',
      [email]
    );

    if (existing.rowCount && existing.rowCount > 0) {
      throw new HttpError(409, 'A user with this email address already exists.');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const employeeCode =
      typeof req.body?.employeeCode === 'string' && req.body.employeeCode.trim()
        ? req.body.employeeCode.trim()
        : `EMP-${Date.now().toString().slice(-4)}`;

    const role = isValidRole(requestedRole) ? requestedRole : 'AP_EMPLOYEE';

    const insertResult = await query<DbUserRow>(
      `
      INSERT INTO users (employee_code, name, email, password_hash, role, department, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, true)
      RETURNING id, employee_code, name, email, role, department, is_active;
      `,
      [employeeCode, name || email.split('@')[0], email, passwordHash, role, department]
    );

    const newUser = insertResult.rows[0];

    const token = jwt.sign(
      {
        sub: String(newUser.id),
        employeeCode: newUser.employee_code,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        department: newUser.department,
      },
      getJwtSecret(),
      { expiresIn: '8h' }
    );

    await writeAuditLog(newUser.id, 'USER_REGISTERED', 'auth', newUser.id, {
      email: newUser.email,
      role: newUser.role,
    });

    res.status(201).json({
      message: 'Registration successful',
      token,
      expiresIn: '8h',
      user: {
        id: newUser.id,
        employeeCode: newUser.employee_code,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        department: newUser.department,
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
