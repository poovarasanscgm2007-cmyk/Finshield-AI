import crypto from 'crypto';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Recursively canonicalizes JSON values so object key order is deterministic
 * across JS objects and PostgreSQL JSONB storage.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();

  const pairs = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`
  );
  return `{${pairs.join(',')}}`;
}

export interface AuditHashInput {
  prevHash: string;
  actorId: number | null;
  action: string;
  entity: string;
  entityId: string;
  payload: unknown;
  createdAtIso: string;
}

/**
 * Computes SHA-256(prev_hash + actor_id + action + entity + entity_id + canonical JSON payload + created_at)
 */
export function computeAuditHash(input: AuditHashInput): string {
  const actorSegment = input.actorId === null || input.actorId === undefined ? 'SYSTEM' : String(input.actorId);
  const canonicalPayload = canonicalizeJson(input.payload ?? {});
  const preimage = `${input.prevHash}|${actorSegment}|${input.action}|${input.entity}|${input.entityId}|${canonicalPayload}|${input.createdAtIso}`;
  return crypto.createHash('sha256').update(preimage).digest('hex');
}
