import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { runMigrations } from '../../database/migrate.ts';
import { SAMPLE_DEMO_USERS, seedDatabase } from '../../database/seed.ts';
import { attachApiErrorHandlers, createApiApp } from '../src/app.ts';
import { env } from '../src/config/env.ts';
import { getPool } from '../src/db/pool.ts';
import { syncAndEvaluateInvoice } from '../src/services/investigationService.ts';
import { syncSupplierGraphRisks } from '../src/services/supplierService.ts';

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

async function loginRole(baseUrl: string, role: string): Promise<string> {
  const account = SAMPLE_DEMO_USERS.find((u) => u.role === role);
  assert.ok(account, `Missing demo user for role ${role}`);
  const res = await apiJson<{ token: string }>(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: account.email, password: account.password },
  });
  assert.equal(res.status, 200, `Login failed for ${role} (${res.status})`);
  return res.data.token;
}

async function main(): Promise<void> {
  let baseUrl = process.env.DEMO_TEST_BASE_URL || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
  let localServer: ReturnType<typeof createServer> | null = null;

  const running = await isServerReachable(baseUrl);
  if (!running) {
    if (!env.DATABASE_URL) {
      throw new Error(
        `No running server reachable at ${baseUrl} and DATABASE_URL is not set.`
      );
    }
    const pool = getPool();
    await runMigrations(pool);
    await seedDatabase(pool);
    const invRes = await pool.query<{ id: number }>(
      "SELECT id FROM invoices WHERE is_historical = FALSE AND invoice_number IN ('INV-101', 'INV_101') ORDER BY id ASC"
    );
    for (const row of invRes.rows) {
      await syncAndEvaluateInvoice(row.id, null);
    }
    await syncSupplierGraphRisks();

    const app = createApiApp();
    attachApiErrorHandlers(app);
    localServer = createServer(app);
    await new Promise<void>((resolve) => {
      localServer!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = localServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  console.log(`Running FINSHIELD AI Expected-Output Test against ${baseUrl}\n`);

  try {
    const adminToken = await loginRole(baseUrl, 'ADMIN');
    const fmToken = await loginRole(baseUrl, 'FINANCE_MANAGER');
    const apToken = await loginRole(baseUrl, 'AP_EMPLOYEE');
    const emp102Token = await loginRole(baseUrl, 'PROCUREMENT_EMPLOYEE');

    // Reset demo data cleanly first
    const resetRes = await apiJson(baseUrl, '/api/system/reset-demo', {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(resetRes.status, 200, 'Expected POST /api/system/reset-demo to succeed');

    // Locate INV-101 and run the full pipeline
    const invListRes = await apiJson<{
      items: Array<{ id: number; invoice_number: string | null; status: string }>;
    }>(baseUrl, '/api/invoices', { token: fmToken });
    assert.equal(invListRes.status, 200);
    const inv101 = invListRes.data.items.find((i) => i.invoice_number === 'INV-101');
    assert.ok(inv101, 'Seeded INV-101 must exist');

    const pipelineRes = await apiJson<{
      pipeline: {
        riskScore: number;
        riskLevel: string;
        itcAtRisk: number;
        reasons: string[];
        flags: Array<{ ruleCode: string; reason: string; metadata: Record<string, unknown> }>;
      };
      investigations: Array<{
        id: number;
        issue_type: string;
        department: string;
        status: string;
      }>;
    }>(baseUrl, `/api/invoices/${inv101.id}/run-pipeline`, {
      method: 'POST',
      token: fmToken,
    });
    assert.equal(pipelineRes.status, 200);

    // 1. INV-101 is ON_HOLD with qty mismatch reason "Invoice qty 100 exceeds received qty 80 by 20"
    const [invDetailRes, invRiskRes] = await Promise.all([
      apiJson<{
        invoice: { id: number; status: string; risk_level: string; risk_score: string | number };
      }>(baseUrl, `/api/invoices/${inv101.id}`, { token: fmToken }),
      apiJson<{
        riskSummary: {
          riskScore: number;
          riskLevel: string;
          itcAtRisk: number;
          flags: Array<{ rule_code: string; reason: string; metadata: Record<string, unknown> }>;
        };
      }>(baseUrl, `/api/invoices/${inv101.id}/investigations`, { token: fmToken }),
    ]);
    assert.equal(invDetailRes.status, 200);
    assert.equal(invRiskRes.status, 200);
    assert.equal(invDetailRes.data.invoice.status, 'ON_HOLD', 'INV-101 status must be ON_HOLD');
    const persistedFlags = invRiskRes.data.riskSummary.flags;

    const matchRes = await apiJson<{
      matchResult: { status: string; reasons: string[] } | null;
    }>(baseUrl, `/api/invoices/${inv101.id}/match-result`, { token: apToken });
    assert.equal(matchRes.status, 200);
    assert.ok(
      matchRes.data.matchResult?.reasons.includes('Invoice qty 100 exceeds received qty 80 by 20'),
      `Expected qty mismatch reason, got ${JSON.stringify(matchRes.data.matchResult?.reasons)}`
    );
    console.log('[PASS] 1. INV-101 ON_HOLD with "Invoice qty 100 exceeds received qty 80 by 20"');

    // 2. PO-101 unapproved price change 500 -> 700 by Employee 102 is flagged
    const unapprovedRes = await apiJson<{
      items: Array<{
        po_id: number;
        po_number: string;
        old_value: string;
        new_value: string;
        changed_by_name: string;
        status: string;
      }>;
    }>(baseUrl, '/api/purchase-orders/unapproved-changes', { token: fmToken });
    assert.equal(unapprovedRes.status, 200);
    const po101Change = unapprovedRes.data.items.find(
      (c) =>
        c.po_number === 'PO-101' &&
        Number(c.old_value) === 500 &&
        Number(c.new_value) === 700 &&
        c.changed_by_name === 'Employee 102' &&
        c.status === 'UNAPPROVED'
    );
    assert.ok(po101Change, 'PO-101 unapproved price change 500 -> 700 by Employee 102 must be flagged');
    console.log('[PASS] 2. PO-101 unapproved price change 500 -> 700 by Employee 102 flagged');

    // 3. Supplier A historical repeated extra charges (500, 700, 1000) detected
    const overbillingFlag = persistedFlags.find(
      (f) => f.rule_code === 'HISTORICAL_OVERBILLING'
    );
    assert.ok(overbillingFlag, 'HISTORICAL_OVERBILLING flag must exist on INV-101');
    const amounts = (overbillingFlag.metadata?.uniqueExtraChargeAmounts as number[]) || [];
    for (const expectedAmt of [500, 700, 1000]) {
      assert.ok(
        amounts.includes(expectedAmt),
        `Expected historical extra charge Rs ${expectedAmt} in ${JSON.stringify(amounts)}`
      );
    }
    console.log('[PASS] 3. Supplier A repeated historical extra charges (500, 700, 1000) detected');

    // 4. Supplier relationship graph detects SHARED_BANK between Supplier A and Supplier B
    const graphRes = await apiJson<{
      disclaimer: string;
      nodes: Array<{ id: number; supplierCode: string; name: string }>;
      edges: Array<{
        type: string;
        source: number;
        target: number;
        sharedValue: string;
        reason: string;
      }>;
    }>(baseUrl, '/api/suppliers/graph', { token: fmToken });
    assert.equal(graphRes.status, 200);
    const supA = graphRes.data.nodes.find((n) => n.supplierCode === 'SUP-A');
    const supB = graphRes.data.nodes.find((n) => n.supplierCode === 'SUP-B');
    assert.ok(supA && supB, 'Supplier A and Supplier B nodes must exist');
    const sharedBankEdge = graphRes.data.edges.find(
      (e) =>
        e.type === 'SHARED_BANK' &&
        ((e.source === supA.id && e.target === supB.id) ||
          (e.source === supB.id && e.target === supA.id))
    );
    assert.ok(sharedBankEdge, 'SHARED_BANK edge between Supplier A and Supplier B must exist');
    assert.match(sharedBankEdge.reason, /Relationship requires verification/i);
    console.log(`[PASS] 4. Supplier graph detects SHARED_BANK (${sharedBankEdge.sharedValue}) between SUP-A & SUP-B`);

    // 5. INV-101 missing in GSTR-2B with ITC at risk 9000
    const gstrFlag = persistedFlags.find((f) => f.rule_code === 'GSTR2B_MISSING');
    assert.ok(gstrFlag, 'GSTR2B_MISSING flag must exist on INV-101');
    assert.equal(pipelineRes.data.pipeline.itcAtRisk, 9000, 'Expected exact ITC at risk = 9000');
    console.log('[PASS] 5. INV-101 missing in GSTR-2B with ITC at risk = Rs 9,000');

    // 6. INV-101 risk_level = 'HIGH'
    assert.equal(invDetailRes.data.invoice.risk_level, 'HIGH', 'INV-101 risk_level must be HIGH');
    console.log(
      `[PASS] 6. INV-101 risk_level = 'HIGH' (score ${invDetailRes.data.invoice.risk_score})`
    );

    // 7. Auto-created investigations assigned to expected departments
    const allInvRes = await apiJson<{
      items: Array<{ id: number; issue_type: string; department: string; status: string }>;
    }>(baseUrl, '/api/investigations', { token: fmToken });
    assert.equal(allInvRes.status, 200);
    const departments = new Set(allInvRes.data.items.map((c) => c.department));
    for (const dept of [
      'WAREHOUSE',
      'PROCUREMENT & FINANCE',
      'AP & FINANCE',
      'FINANCE & COMPLIANCE',
    ]) {
      assert.ok(
        departments.has(dept),
        `Expected investigation assigned to ${dept}; got ${Array.from(departments).join(', ')}`
      );
    }
    console.log('[PASS] 7. Auto-created investigations assigned across all 4 expected departments');

    // 10 (checked before mutating PO-101 approval). Payment is blocked while investigations unresolved
    const blockedPayRes = await apiJson<{ error?: string }>(
      baseUrl,
      `/api/invoices/${inv101.id}/approve-payment`,
      {
        method: 'POST',
        token: fmToken,
        body: { level: 2 },
      }
    );
    assert.equal(
      blockedPayRes.status,
      409,
      `Payment must be blocked (409) while investigations remain unresolved, got ${blockedPayRes.status}`
    );
    console.log('[PASS] 10. Payment blocked (409) while investigations remain unresolved');

    // 8. Maker-checker blocks Employee 102 from approving own request; Finance Manager can approve
    const poReqRes = await apiJson<{ approval: { id: number } }>(
      baseUrl,
      `/api/purchase-orders/${po101Change.po_id}/price`,
      {
        method: 'PUT',
        token: emp102Token,
        body: { newUnitPrice: 700, reason: 'Expected-output test maker-checker request' },
      }
    );
    assert.equal(poReqRes.status, 202);
    const approvalId = poReqRes.data.approval.id;

    const selfApproveRes = await apiJson<{ error?: string }>(
      baseUrl,
      `/api/approvals/${approvalId}/approve`,
      { method: 'POST', token: emp102Token }
    );
    assert.equal(selfApproveRes.status, 403, 'Employee 102 self-approval must return 403');
    assert.match(String(selfApproveRes.data.error), /Maker-checker violation/i);

    const fmApproveRes = await apiJson<{ approval: { status: string } }>(
      baseUrl,
      `/api/approvals/${approvalId}/approve`,
      {
        method: 'POST',
        token: fmToken,
        body: { remarks: 'Finance Manager approval check' },
      }
    );
    assert.equal(fmApproveRes.status, 200);
    assert.equal(fmApproveRes.data.approval.status, 'APPROVED');
    console.log('[PASS] 8. Maker-checker blocked Employee 102 (403) and allowed Finance Manager (200)');

    // 9. Hash-chained audit log passes verification
    const auditVerifyRes = await apiJson<{ valid: boolean; totalEntries: number }>(
      baseUrl,
      '/api/audit-log/verify',
      { token: adminToken }
    );
    assert.equal(auditVerifyRes.status, 200);
    assert.equal(auditVerifyRes.data.valid, true, 'Audit log SHA-256 chain must be valid');
    console.log(
      `[PASS] 9. Hash-chained audit log verified valid (${auditVerifyRes.data.totalEntries} entries)`
    );

    // Compute real sample metrics before final reset
    const detectedCount = [
      matchRes.data.matchResult?.status === 'MISMATCH',
      Boolean(po101Change),
      Boolean(overbillingFlag),
      Boolean(sharedBankEdge),
      Boolean(gstrFlag),
      Boolean(
        persistedFlags.some((f) => f.rule_code === 'DUPLICATE_INVOICE') ||
          (await apiJson<{ hasPossibleDuplicates: boolean }>(
            baseUrl,
            `/api/invoices/${inv101.id}/duplicates`,
            { token: apToken }
          )).data.hasPossibleDuplicates
      ),
    ].filter(Boolean).length;
    const sampleInvoiceCount = invListRes.data.items.length;

    // Restore crisp demo seed state cleanly
    const restoreRes = await apiJson(baseUrl, '/api/system/reset-demo', {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(restoreRes.status, 200);

    console.log(
      `\nTested on ${sampleInvoiceCount} sample invoices, 6 issues planted, ${detectedCount} detected`
    );
  } finally {
    if (localServer) {
      await new Promise<void>((resolve) => localServer!.close(() => resolve()));
      await getPool().end();
    }
  }
}

main().catch((err) => {
  console.error('\nExpected-output demo test failed:', err);
  process.exit(1);
});
