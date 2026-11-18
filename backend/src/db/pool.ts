import { Pool, QueryResult, QueryResultRow } from 'pg';
import { env } from '../config/env.ts';

let poolInstance: Pool | null = null;

export function getPool(): Pool {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not configured.');
  }

  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });

    poolInstance.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err.message);
    });
  }

  return poolInstance;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const pool = getPool();
  return pool.query<T>(text, params);
}

export interface DatabaseHealth {
  configured: boolean;
  connected: boolean;
  message: string;
}

export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  if (!env.DATABASE_URL) {
    return {
      configured: false,
      connected: false,
      message: 'DATABASE_URL is not set. Configure PostgreSQL in .env to enable database queries.',
    };
  }

  try {
    await query('SELECT 1 AS ok');
    return {
      configured: true,
      connected: true,
      message: 'PostgreSQL connection healthy',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database connection error';
    return {
      configured: true,
      connected: false,
      message: `PostgreSQL unreachable: ${message}`,
    };
  }
}
