import { runMigrations } from '../../../database/migrate.ts';
import { seedDatabase } from '../../../database/seed.ts';
import { env } from '../config/env.ts';
import { getPool } from '../db/pool.ts';

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
        }
      } catch (err) {
        console.error('Database bootstrap warning:', err instanceof Error ? err.message : err);
        bootstrapPromise = null;
      }
    })();
  }

  await bootstrapPromise;
}
