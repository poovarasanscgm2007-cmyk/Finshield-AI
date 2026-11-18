import { runMigrations } from '../../database/migrate.ts';
import { SAMPLE_DEMO_USERS, seedDatabase } from '../../database/seed.ts';
import { env } from '../src/config/env.ts';
import { getPool } from '../src/db/pool.ts';
import { syncAndEvaluateInvoice } from '../src/services/investigationService.ts';
import { syncSupplierGraphRisks } from '../src/services/supplierService.ts';

async function main(): Promise<void> {
  if (env.DATABASE_URL) {
    const pool = getPool();
    try {
      await runMigrations(pool);
      await seedDatabase(pool);

      const invRes = await pool.query<{ id: number }>(
        `
        SELECT id
        FROM invoices
        WHERE is_historical = FALSE
          AND invoice_number IN ('INV-101', 'INV_101')
        ORDER BY id ASC;
        `
      );

      for (const row of invRes.rows) {
        await syncAndEvaluateInvoice(row.id, null);
      }

      await syncSupplierGraphRisks();

      console.log(
        `Demo database reset to original sample seed state (${invRes.rows.length} active demo invoice(s) evaluated).`
      );
      return;
    } finally {
      await pool.end();
    }
  }

  // Fallback: reset through running local server if DATABASE_URL is only present inside server environment
  const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
  const admin = SAMPLE_DEMO_USERS.find((u) => u.role === 'ADMIN')!;
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: admin.email, password: admin.password }),
  });

  if (!loginRes.ok) {
    throw new Error(
      `DATABASE_URL is not set in shell and failed to reach ${baseUrl} for reset (HTTP ${loginRes.status}).`
    );
  }
  const { token } = (await loginRes.json()) as { token: string };
  const resetRes = await fetch(`${baseUrl}/api/system/reset-demo`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!resetRes.ok) {
    const body = await resetRes.text();
    throw new Error(`Demo reset failed (HTTP ${resetRes.status}): ${body}`);
  }
  const payload = (await resetRes.json()) as { message: string };
  console.log(payload.message);
}

main().catch((err) => {
  console.error('reset-demo failed:', err);
  process.exit(1);
});
