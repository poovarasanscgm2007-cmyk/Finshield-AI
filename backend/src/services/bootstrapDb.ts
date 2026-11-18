import { runMigrations } from '../../../database/migrate.ts';
import { seedDatabase } from '../../../database/seed.ts';
import { env } from '../config/env.ts';
import { getPool } from '../db/pool.ts';
import { syncAndEvaluateInvoice } from './investigationService.ts';

let bootstrapPromise: Promise<void> | null = null;

/**
 * Ensures migrations and Phase 2 bcrypt sample seed exist when running against a fresh
 * PostgreSQL database (for example, when AI Studio Secrets provide DATABASE_URL at runtime).
 * Never overwrites data once Phase 2 bcrypt users are present.
 */
export async function ensureDatabaseBootstrapped(): Promise<void> {
  if (!env.DATABASE_URL) {
    return;
  }

  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      try {
        const pool = getPool();
        await runMigrations(pool);

        const usersCheck = await pool.query<{
          count: string;
          has_placeholder: boolean;
        }>(`
          SELECT
            COUNT(*)::text AS count,
            BOOL_OR(password_hash = 'SAMPLE_HASH_NOT_FOR_PROD') AS has_placeholder
          FROM users;
        `);

        const row = usersCheck.rows[0];
        const count = Number(row?.count || 0);
        const hasPlaceholder = Boolean(row?.has_placeholder);

        if (count === 0 || hasPlaceholder) {
          await seedDatabase(pool);
          console.log('[OK] Database bootstrapped with Phase 2 schema and sample bcrypt users.');
        } else {
          // Ensure Phase 4 duplicate sample (INV_101) exists alongside INV-101 without altering PO-101 or existing rows
          const dupCheck = await pool.query<{ id: number }>(
            "SELECT id FROM invoices WHERE invoice_number = 'INV_101' LIMIT 1"
          );
          if (dupCheck.rowCount === 0) {
            const baseInvRes = await pool.query<{
              supplier_id: number;
              po_id: number | null;
              uploaded_by: number | null;
            }>(
              "SELECT supplier_id, po_id, uploaded_by FROM invoices WHERE invoice_number = 'INV-101' ORDER BY id ASC LIMIT 1"
            );
            const baseInv = baseInvRes.rows[0];
            if (baseInv && baseInv.supplier_id) {
              const insertedDup = await pool.query<{ id: number }>(
                `
                INSERT INTO invoices (
                  invoice_number, normalized_invoice_number, irn, supplier_id, po_id, invoice_date,
                  subtotal, cgst, sgst, igst, extra_charges, total, status,
                  extraction_confidence, file_path, original_filename, uploaded_by, is_historical, is_sample_data
                )
                VALUES (
                  'INV_101', 'INV101', 'IRN-SAMPLE-2026-INV101-A98F', $1, $2, CURRENT_DATE,
                  50000.00, 4500.00, 4500.00, 0.00, 0.00, 59000.00, 'PENDING_REVIEW',
                  '{"invoice_number": 0.96, "supplier_gstin": 0.96, "quantity": 0.95, "unit_price": 0.96, "total": 0.97}'::jsonb,
                  'sample-data/INV_101-duplicate-sample.pdf', 'INV_101-duplicate-sample (Sample Data).pdf', $3, FALSE, TRUE
                )
                RETURNING id;
                `,
                [baseInv.supplier_id, baseInv.po_id, baseInv.uploaded_by]
              );
              await pool.query(
                `
                INSERT INTO invoice_lines (
                  invoice_id, line_number, description, hsn_sac, quantity, unit,
                  unit_price, extra_charge, tax_rate, line_total, is_sample_data
                )
                VALUES (
                  $1, 1, 'Industrial Hardwood Timber (Sample)', '4403', 100.000, 'kg',
                  500.00, 0.00, 18.00, 59000.00, TRUE
                );
                `,
                [insertedDup.rows[0].id]
              );
            }
          }
        }

        // Ensure seeded active invoices (INV-101 / INV_101) have initial Phase 5 pipeline risk flags & investigations populated
        const invToEvalRes = await pool.query<{ id: number }>(
          `
          SELECT i.id
          FROM invoices i
          WHERE i.is_historical = FALSE
            AND i.invoice_number IN ('INV-101', 'INV_101')
            AND NOT EXISTS (
              SELECT 1 FROM investigations inv WHERE inv.invoice_id = i.id
            )
          ORDER BY i.id ASC;
          `
        );
        for (const row of invToEvalRes.rows) {
          await syncAndEvaluateInvoice(row.id, null);
        }
      } catch (err) {
        console.error('Database bootstrap warning:', err instanceof Error ? err.message : err);
        bootstrapPromise = null;
      }
    })();
  }

  await bootstrapPromise;
}
