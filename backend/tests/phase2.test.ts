import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { Pool } from 'pg';
import { runMigrations } from '../../database/migrate.ts';
import { SAMPLE_DEMO_USERS, seedDatabase } from '../../database/seed.ts';
import { attachApiErrorHandlers, createApiApp } from '../src/app.ts';
import { computeAuditHash, GENESIS_HASH } from '../src/audit/hashChain.ts';
import { hasPermission } from '../src/auth/permissions.ts';
import { env } from '../src/config/env.ts';

describe('Phase 2 Unit Checks (RBAC & Hash Chain)', () => {
  test('permissions map enforces that Admin cannot approve payments or PO changes', () => {
    assert.equal(hasPermission('FINANCE_MANAGER', 'payments:approve_final'), true);
    assert.equal(hasPermission('FINANCE_MANAGER', 'approvals:decide_po_change'), true);
    assert.equal(hasPermission('ADMIN', 'payments:approve_final'), false);
    assert.equal(hasPermission('ADMIN', 'approvals:decide_po_change'), false);
    assert.equal(hasPermission('ADMIN', 'audit_log:verify'), true);
    assert.equal(hasPermission('WAREHOUSE_EMPLOYEE', 'audit_log:read'), false);
  });

  test('computeAuditHash is deterministic regardless of object key order and detects tampering', () => {
    const ts = '2026-11-18T10:00:00.000Z';
    const hashA = computeAuditHash({
      prevHash: GENESIS_HASH,
      actorId: 2,
      action: 'PO_PRICE_CHANGE_REQUESTED',
      entity: 'purchase_orders',
      entityId: '1',
      payload: { newUnitPrice: 700, oldUnitPrice: 500, nested: { b: 2, a: 1 } },
      createdAtIso: ts,
    });
    const hashB = computeAuditHash({
      prevHash: GENESIS_HASH,
      actorId: 2,
      action: 'PO_PRICE_CHANGE_REQUESTED',
      entity: 'purchase_orders',
      entityId: '1',
      payload: { nested: { a: 1, b: 2 }, oldUnitPrice: 500, newUnitPrice: 700 },
      createdAtIso: ts,
    });
    const hashTampered = computeAuditHash({
      prevHash: GENESIS_HASH,
      actorId: 2,
      action: 'PO_PRICE_CHANGE_REQUESTED',
      entity: 'purchase_orders',
      entityId: '1',
      payload: { newUnitPrice: 999, oldUnitPrice: 500, nested: { a: 1, b: 2 } },
      createdAtIso: ts,
    });

    assert.equal(hashA, hashB);
    assert.notEqual(hashA, hashTampered);
  });
});

const hasDatabase = Boolean(env.DATABASE_URL);

describe('Phase 2 Integration Tests (PostgreSQL + API)', { skip: !hasDatabase }, () => {
  let pool: Pool;
  let baseUrl = '';
  let server: ReturnType<typeof createServer>;

  async function apiRequest(
    path: string,
    options: { method?: string; token?: string; body?: unknown } = {}
  ) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  before(async () => {
    pool = new Pool({ connectionString: env.DATABASE_URL });
    await runMigrations(pool);
    await seedDatabase(pool);

    const app = createApiApp();
    attachApiErrorHandlers(app);
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    // Always restore clean seeded state so PO-101 retains its UNAPPROVED change for the demo
    await seedDatabase(pool);
    await pool.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('login works for each role and wrong password fails and is logged', async () => {
    for (const demoUser of SAMPLE_DEMO_USERS) {
      const ok = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { email: demoUser.email, password: demoUser.password },
      });
      assert.equal(ok.status, 200);
      assert.ok(ok.data.token);
      assert.equal(ok.data.user.role, demoUser.role);
    }

    const bad = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'employee102@abcmfg.sample', password: 'WrongPassword!' },
    });
    assert.equal(bad.status, 401);

    const logCheck = await pool.query(
      "SELECT action FROM audit_log WHERE action = 'LOGIN_FAILURE' ORDER BY id DESC LIMIT 1"
    );
    assert.equal(logCheck.rowCount, 1);
  });

  test('Warehouse Employee calling Finance/Admin-only endpoint receives 403', async () => {
    const whLogin = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'warehouse@abcmfg.sample', password: 'SamplePass@103' },
    });
    const res = await apiRequest('/api/audit-log', {
      token: whLogin.data.token,
    });
    assert.equal(res.status, 403);
  });

  test('Maker-checker blocks Employee 102 self-approval and Finance Manager approval succeeds', async () => {
    const emp102Login = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'employee102@abcmfg.sample', password: 'SamplePass@102' },
    });
    const fmLogin = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'finance.manager@abcmfg.sample', password: 'SamplePass@104' },
    });
    const adminLogin = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@abcmfg.sample', password: 'SamplePass@105' },
    });

    const poRes = await pool.query<{ id: number }>(
      "SELECT id FROM purchase_orders WHERE po_number = 'PO-101'"
    );
    const poId = poRes.rows[0].id;

    // Employee 102 creates a new pending PO price change request (500 to 700)
    const reqRes = await apiRequest(`/api/purchase-orders/${poId}/price`, {
      method: 'PUT',
      token: emp102Login.data.token,
      body: { newUnitPrice: 700, reason: 'Phase 2 integration test request' },
    });
    assert.equal(reqRes.status, 202);
    const approvalId = reqRes.data.approval.id;

    // Self-approval by Employee 102 must be blocked with 403 Maker-checker violation
    const selfApprove = await apiRequest(`/api/approvals/${approvalId}/approve`, {
      method: 'POST',
      token: emp102Login.data.token,
    });
    assert.equal(selfApprove.status, 403);
    assert.match(String(selfApprove.data.error), /Maker-checker violation/i);

    // Admin must also be blocked from approving PO price changes / payments
    const adminApprove = await apiRequest(`/api/approvals/${approvalId}/approve`, {
      method: 'POST',
      token: adminLogin.data.token,
    });
    assert.equal(adminApprove.status, 403);

    // Finance Manager approving succeeds
    const fmApprove = await apiRequest(`/api/approvals/${approvalId}/approve`, {
      method: 'POST',
      token: fmLogin.data.token,
      body: { remarks: 'Verified with supplier quote' },
    });
    assert.equal(fmApprove.status, 200);
    assert.equal(fmApprove.data.approval.status, 'APPROVED');

    // Re-approving is immutable (409 Conflict)
    const secondApprove = await apiRequest(`/api/approvals/${approvalId}/approve`, {
      method: 'POST',
      token: fmLogin.data.token,
    });
    assert.equal(secondApprove.status, 409);

    // Seeded UNAPPROVED PO-101 history row must still exist
    const unapproved = await pool.query(
      "SELECT status, approval_id FROM po_change_history WHERE po_id = $1 AND status = 'UNAPPROVED'",
      [poId]
    );
    assert.equal(unapproved.rowCount, 1);
    assert.equal(unapproved.rows[0].approval_id, null);
  });

  test('audit_log rejects UPDATE/DELETE and verify detects manual tampering', async () => {
    const adminLogin = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@abcmfg.sample', password: 'SamplePass@105' },
    });

    const validRes = await apiRequest('/api/audit-log/verify', {
      token: adminLogin.data.token,
    });
    assert.equal(validRes.status, 200);
    assert.equal(validRes.data.valid, true);

    await assert.rejects(
      () => pool.query("UPDATE audit_log SET action = 'TAMPERED' WHERE id = 1"),
      /append-only/i
    );
    await assert.rejects(
      () => pool.query('DELETE FROM audit_log WHERE id = 1'),
      /append-only/i
    );

    // Simulate tampering in a controlled DB test by temporarily disabling trigger on row 2, verifying brokenAtId === 2, then re-enabling
    const client = await pool.connect();
    try {
      await client.query('ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_no_update');
      await client.query("UPDATE audit_log SET action = 'TAMPERED_TEST' WHERE id = 2");

      const brokenRes = await apiRequest('/api/audit-log/verify', {
        token: adminLogin.data.token,
      });
      assert.equal(brokenRes.status, 200);
      assert.equal(brokenRes.data.valid, false);
      assert.equal(brokenRes.data.brokenAtId, 2);
    } finally {
      await client.query('ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_no_update');
      client.release();
    }
  });
});
