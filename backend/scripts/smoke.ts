import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { runMigrations } from '../../database/migrate.ts';
import { SAMPLE_DEMO_USERS, seedDatabase } from '../../database/seed.ts';
import { attachApiErrorHandlers, createApiApp } from '../src/app.ts';
import { env } from '../src/config/env.ts';
import { getPool } from '../src/db/pool.ts';

interface SmokeStepResult {
  name: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

const results: SmokeStepResult[] = [];

async function runStep(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail });
    console.log(`[PASS] ${name} — ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', detail });
    console.error(`[FAIL] ${name} — ${detail}`);
    throw err;
  }
}

async function isServerReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`);
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { service?: string };
    return data.service === 'finshield-ai-backend';
  } catch {
    return false;
  }
}

async function apiJson<T = Record<string, unknown>>(
  baseUrl: string,
  route: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

async function loginRole(
  baseUrl: string,
  email: string,
  password: string
): Promise<{ token: string; user: { id: number; role: string; name: string } }> {
  const res = await apiJson<{
    token: string;
    user: { id: number; role: string; name: string };
    error?: string;
  }>(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(res.status, 200, `Expected 200 logging in ${email}, got ${res.status}`);
  assert.ok(res.data.token, `Missing JWT for ${email}`);
  return res.data;
}

async function main(): Promise<void> {
  let baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
  let localServer: ReturnType<typeof createServer> | null = null;

  const running = await isServerReachable(baseUrl);
  if (!running) {
    if (!env.DATABASE_URL) {
      throw new Error(
        `No running server reachable at ${baseUrl} and DATABASE_URL is not set in environment.`
      );
    }
    const pool = getPool();
    await runMigrations(pool);
    await seedDatabase(pool);
    const app = createApiApp();
    attachApiErrorHandlers(app);
    localServer = createServer(app);
    await new Promise<void>((resolve) => {
      localServer!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = localServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  console.log(`Running FINSHIELD AI Smoke Test Suite against ${baseUrl}\n`);

  const tokens: Record<string, string> = {};

  try {
    // 1. Health check
    await runStep('Health check (GET /api/health)', async () => {
      const res = await apiJson<{ status: string; database?: { connected: boolean } }>(
        baseUrl,
        '/api/health'
      );
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'ok');
      assert.equal(res.data.database?.connected, true);
      return 'Backend & PostgreSQL healthy';
    });

    // 2. Login for all 5 roles
    await runStep('Login for all 5 RBAC roles', async () => {
      for (const acc of SAMPLE_DEMO_USERS) {
        const logged = await loginRole(baseUrl, acc.email, acc.password);
        assert.equal(logged.user.role, acc.role);
        tokens[acc.role] = logged.token;
      }
      return '5/5 roles authenticated';
    });

    // 3. 403 on forbidden routes
    await runStep('RBAC 403 enforcement on forbidden routes', async () => {
      const whAudit = await apiJson(baseUrl, '/api/audit-log', {
        token: tokens.WAREHOUSE_EMPLOYEE,
      });
      assert.equal(whAudit.status, 403, 'Warehouse accessing /api/audit-log must return 403');

      const whUpload = await apiJson(baseUrl, '/api/invoices/upload', {
        method: 'POST',
        token: tokens.WAREHOUSE_EMPLOYEE,
      });
      assert.equal(whUpload.status, 403, 'Warehouse accessing /api/invoices/upload must return 403');

      const fmUpload = await apiJson(baseUrl, '/api/invoices/upload', {
        method: 'POST',
        token: tokens.FINANCE_MANAGER,
      });
      assert.equal(fmUpload.status, 403, 'Finance Manager accessing /api/invoices/upload must return 403');

      return '403 enforced for unauthorized audit & upload routes';
    });

    // 4. Maker-checker block (using HIGH_RISK_ITEM so PO-101 seeded UNAPPROVED change remains untouched)
    await runStep('Maker-checker self-approval block & Admin payment block', async () => {
      const created = await apiJson<{ approval: { id: number } }>(baseUrl, '/api/approvals', {
        method: 'POST',
        token: tokens.PROCUREMENT_EMPLOYEE,
        body: {
          entityType: 'HIGH_RISK_ITEM',
          entityId: 1,
          payload: { note: 'Smoke test maker-checker verification' },
        },
      });
      assert.equal(created.status, 201);
      const approvalId = created.data.approval.id;

      const selfApprove = await apiJson<{ error?: string }>(
        baseUrl,
        `/api/approvals/${approvalId}/approve`,
        {
          method: 'POST',
          token: tokens.PROCUREMENT_EMPLOYEE,
        }
      );
      assert.equal(selfApprove.status, 403);
      assert.match(String(selfApprove.data.error), /Maker-checker violation/i);

      const adminApprove = await apiJson(
        baseUrl,
        `/api/approvals/${approvalId}/approve`,
        {
          method: 'POST',
          token: tokens.ADMIN,
        }
      );
      assert.equal(adminApprove.status, 403);

      const fmApprove = await apiJson<{ approval: { status: string } }>(
        baseUrl,
        `/api/approvals/${approvalId}/approve`,
        {
          method: 'POST',
          token: tokens.FINANCE_MANAGER,
          body: { remarks: 'Approved in smoke test' },
        }
      );
      assert.equal(fmApprove.status, 200);
      assert.equal(fmApprove.data.approval.status, 'APPROVED');

      // Ensure PO-101 still retains its UNAPPROVED history record
      const unapprovedRes = await apiJson<{ items: Array<{ po_number: string; status: string }> }>(
        baseUrl,
        '/api/purchase-orders/unapproved-changes',
        { token: tokens.FINANCE_MANAGER }
      );
      assert.equal(unapprovedRes.status, 200);
      assert.ok(
        unapprovedRes.data.items.some(
          (c) => c.po_number === 'PO-101' && c.status === 'UNAPPROVED'
        ),
        'Seeded PO-101 UNAPPROVED change must remain intact'
      );

      return `Approval #${approvalId} blocked self/Admin (403) and approved by Finance Manager (200); PO-101 UNAPPROVED intact`;
    });

    // 5. Audit chain verify
    await runStep('Hash-chained audit log verification (GET /api/audit-log/verify)', async () => {
      const verify = await apiJson<{ valid: boolean; totalEntries: number }>(
        baseUrl,
        '/api/audit-log/verify',
        { token: tokens.ADMIN }
      );
      assert.equal(verify.status, 200);
      assert.equal(verify.data.valid, true);
      assert.ok(verify.data.totalEntries > 0);
      return `Chain valid across ${verify.data.totalEntries} audit entries`;
    });

    // 6. Invoice upload of sample INV-101 + scanned INV-099 + verification flow
    await runStep('Invoice upload INV-101-sample.pdf returns extracted fields & confidences', async () => {
      const samplePath = path.resolve(process.cwd(), 'sample-data/invoices/INV-101-sample.pdf');
      const fileBuf = fs.readFileSync(samplePath);
      const form = new FormData();
      form.append('file', new Blob([fileBuf], { type: 'application/pdf' }), 'INV-101-sample.pdf');

      const uploadRes = await fetch(`${baseUrl}/api/invoices/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.AP_EMPLOYEE}` },
        body: form,
      });
      const uploadData = (await uploadRes.json()) as {
        invoice: {
          id: number;
          invoice_number: string | null;
          normalized_invoice_number: string | null;
          supplier_gstin_extracted: string | null;
          po_reference_extracted: string | null;
          subtotal: string | null;
          total: string | null;
          status: string;
          extraction_source: string;
          extraction_method: string;
        };
        lines: Array<{ description: string; quantity: string; unit_price: string }>;
        extraction: {
          extractionConfidence: { fields: Record<string, { confidence: number; status: string }> };
        };
      };

      assert.equal(uploadRes.status, 201, `Upload failed: ${JSON.stringify(uploadData)}`);
      assert.equal(uploadData.invoice.invoice_number, 'INV-101');
      assert.equal(uploadData.invoice.normalized_invoice_number, 'INV101');
      assert.equal(uploadData.invoice.supplier_gstin_extracted, '27AABCS5678C1Z9');
      assert.equal(uploadData.invoice.po_reference_extracted, 'PO-101');
      assert.equal(Number(uploadData.invoice.subtotal), 50000);
      assert.equal(Number(uploadData.invoice.total), 59000);
      assert.ok(uploadData.lines.length >= 1, 'Expected at least 1 extracted line item');
      assert.ok(
        uploadData.extraction.extractionConfidence.fields.invoice_number.confidence > 0,
        'Expected per-field confidence score'
      );

      // Verify file preview endpoint works for uploaded PDF
      const filePreviewRes = await fetch(`${baseUrl}/api/invoices/${uploadData.invoice.id}/file`, {
        headers: { Authorization: `Bearer ${tokens.AP_EMPLOYEE}` },
      });
      assert.equal(filePreviewRes.status, 200);
      assert.match(filePreviewRes.headers.get('content-type') || '', /application\/pdf/);

      return `Invoice #${uploadData.invoice.id} (${uploadData.invoice.extraction_source}/${uploadData.invoice.extraction_method}) status=${uploadData.invoice.status}`;
    });

    await runStep('Scanned PDF INV-099 OCR + AP Employee verification & post-verify audit check', async () => {
      const scanPath = path.resolve(
        process.cwd(),
        'sample-data/invoices/INV-099-scanned-sample.pdf'
      );
      const fileBuf = fs.readFileSync(scanPath);
      const form = new FormData();
      form.append(
        'file',
        new Blob([fileBuf], { type: 'application/pdf' }),
        'INV-099-scanned-sample.pdf'
      );

      const uploadRes = await fetch(`${baseUrl}/api/invoices/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.AP_EMPLOYEE}` },
        body: form,
      });
      const uploadData = (await uploadRes.json()) as {
        invoice: {
          id: number;
          status: string;
          extraction_method: string;
          extraction_source: string;
        };
      };
      assert.equal(uploadRes.status, 201);
      assert.equal(uploadData.invoice.extraction_method, 'TESSERACT_OCR');
      assert.equal(
        uploadData.invoice.status,
        'NEEDS_VERIFICATION',
        `Expected scanned low-quality PDF to require verification, got ${uploadData.invoice.status}`
      );

      const verifyRes = await apiJson<{
        invoice: { status: string; normalized_invoice_number: string; verified_by: number };
      }>(baseUrl, `/api/invoices/${uploadData.invoice.id}/verify`, {
        method: 'PUT',
        token: tokens.AP_EMPLOYEE,
        body: {
          supplierName: 'Supplier A - Timber & Wood Traders (Sample)',
          supplierGstin: '27AABCS5678C1Z9',
          invoiceNumber: 'INV-099',
          invoiceDate: '2026-11-08',
          poReference: 'PO-099',
          subtotal: 48500,
          cgst: 4365,
          sgst: 4365,
          igst: 0,
          total: 57230,
        },
      });
      assert.equal(verifyRes.status, 200);
      assert.equal(verifyRes.data.invoice.status, 'VERIFIED');
      assert.equal(verifyRes.data.invoice.normalized_invoice_number, 'INV099');

      // Re-verify audit hash chain after invoice upload + verification entries
      const postAudit = await apiJson<{ valid: boolean; totalEntries: number }>(
        baseUrl,
        '/api/audit-log/verify',
        { token: tokens.FINANCE_MANAGER }
      );
      assert.equal(postAudit.status, 200);
      assert.equal(postAudit.data.valid, true);

      return `Scanned #${uploadData.invoice.id} (${uploadData.invoice.status} via ${uploadData.invoice.extraction_method}) verified -> VERIFIED; audit valid (${postAudit.data.totalEntries} rows)`;
    });

    console.log(`\nALL ${results.length} SMOKE CHECKS PASSED.`);
  } finally {
    if (localServer) {
      await new Promise<void>((resolve) => localServer!.close(() => resolve()));
      await getPool().end();
    }
  }
}

main().catch((err) => {
  console.error('\nSmoke suite failed:', err);
  process.exit(1);
});
