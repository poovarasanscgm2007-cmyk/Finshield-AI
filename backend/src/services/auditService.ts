import { PoolClient } from 'pg';
import { computeAuditHash, GENESIS_HASH } from '../audit/hashChain.ts';
import { getPool, query } from '../db/pool.ts';

export interface AuditLogEntry {
  id: number;
  actor_id: number | null;
  actor_name?: string | null;
  actor_email?: string | null;
  actor_role?: string | null;
  action: string;
  entity: string;
  entity_id: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  is_sample_data: boolean;
  created_at: string;
}

const AUDIT_CHAIN_LOCK_KEY = 918273645;

/**
 * Writes an entry to the hash-chained audit_log table inside a serialized transaction
 * using a PostgreSQL transaction-scoped advisory lock so the chain never forks.
 */
export async function writeAuditLog(
  actorId: number | null,
  action: string,
  entity: string,
  entityId: string | number,
  payload: Record<string, unknown> = {},
  externalClient?: PoolClient
): Promise<AuditLogEntry> {
  const pool = getPool();
  const ownsClient = !externalClient;
  const client = externalClient ?? (await pool.connect());

  try {
    if (ownsClient) {
      await client.query('BEGIN');
    }

    // Serialize all audit_log writers across concurrent requests
    await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_CHAIN_LOCK_KEY]);

    const prevRes = await client.query<{ hash: string }>(
      'SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1'
    );
    const prevHash = prevRes.rows[0]?.hash ?? GENESIS_HASH;

    const createdAtIso = new Date().toISOString();
    const entityIdStr = String(entityId);
    const hash = computeAuditHash({
      prevHash,
      actorId,
      action,
      entity,
      entityId: entityIdStr,
      payload,
      createdAtIso,
    });

    const insertRes = await client.query<AuditLogEntry>(
      `
      INSERT INTO audit_log (actor_id, action, entity, entity_id, payload, prev_hash, hash, is_sample_data, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, TRUE, $8::timestamptz)
      RETURNING id::int, actor_id, action, entity, entity_id, payload, prev_hash, hash, is_sample_data, created_at;
      `,
      [actorId, action, entity, entityIdStr, JSON.stringify(payload), prevHash, hash, createdAtIso]
    );

    if (ownsClient) {
      await client.query('COMMIT');
    }

    return insertRes.rows[0];
  } catch (err) {
    if (ownsClient) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

export interface AuditListFilters {
  page?: number;
  limit?: number;
  action?: string;
  entity?: string;
  actorId?: number;
}

export async function listAuditLogs(filters: AuditListFilters = {}) {
  const page = Math.max(1, Number(filters.page || 1));
  const limit = Math.min(100, Math.max(1, Number(filters.limit || 25)));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.action) {
    params.push(filters.action);
    conditions.push(`a.action = $${params.length}`);
  }
  if (filters.entity) {
    params.push(filters.entity);
    conditions.push(`a.entity = $${params.length}`);
  }
  if (filters.actorId !== undefined && !Number.isNaN(filters.actorId)) {
    params.push(filters.actorId);
    conditions.push(`a.actor_id = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM audit_log a ${whereClause}`,
    params
  );
  const total = Number(countRes.rows[0]?.total || 0);

  const dataParams = [...params, limit, offset];
  const itemsRes = await query<AuditLogEntry>(
    `
    SELECT
      a.id::int AS id,
      a.actor_id,
      u.name AS actor_name,
      u.email AS actor_email,
      u.role AS actor_role,
      a.action,
      a.entity,
      a.entity_id,
      a.payload,
      a.prev_hash,
      a.hash,
      a.is_sample_data,
      a.created_at
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_id
    ${whereClause}
    ORDER BY a.id DESC
    LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length};
    `,
    dataParams
  );

  return {
    items: itemsRes.rows,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export interface VerifyChainResult {
  valid: boolean;
  totalEntries: number;
  brokenAtId?: number;
  reason?: string;
}

/**
 * Recomputes the entire hash chain from genesis and returns { valid: true }
 * or { valid: false, brokenAtId }.
 */
export async function verifyAuditChain(): Promise<VerifyChainResult> {
  const res = await query<{
    id: number;
    actor_id: number | null;
    action: string;
    entity: string;
    entity_id: string;
    payload: Record<string, unknown>;
    prev_hash: string;
    hash: string;
    created_at: Date | string;
  }>(
    `
    SELECT id::int AS id, actor_id, action, entity, entity_id, payload, prev_hash, hash, created_at
    FROM audit_log
    ORDER BY id ASC;
    `
  );

  const rows = res.rows;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const expectedPrevHash = i === 0 ? GENESIS_HASH : rows[i - 1].hash;

    if (row.prev_hash !== expectedPrevHash) {
      return {
        valid: false,
        totalEntries: rows.length,
        brokenAtId: Number(row.id),
        reason: `prev_hash mismatch at audit_log id=${row.id}`,
      };
    }

    const createdAtIso =
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString();

    const expectedHash = computeAuditHash({
      prevHash: row.prev_hash,
      actorId: row.actor_id,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      payload: row.payload,
      createdAtIso,
    });

    if (row.hash !== expectedHash) {
      return {
        valid: false,
        totalEntries: rows.length,
        brokenAtId: Number(row.id),
        reason: `Hash mismatch at audit_log id=${row.id} (record contents altered)`,
      };
    }
  }

  return {
    valid: true,
    totalEntries: rows.length,
  };
}
