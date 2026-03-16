/**
 * Payment audit log helper.
 *
 * All payment state changes MUST produce an audit entry via this module.
 * The payment_audit_log table is append-only — no UPDATE or DELETE.
 */
import { queryOne } from '@leasebase/service-common';

export type EntityType = 'CHARGE' | 'PAYMENT_TRANSACTION' | 'PAYMENT_ACCOUNT' | 'REFUND';
export type AuditAction = 'CREATED' | 'STATUS_CHANGED' | 'AMOUNT_UPDATED' | 'VOIDED';
export type ActorType = 'SYSTEM' | 'USER' | 'WEBHOOK';

export interface AuditEntry {
  organizationId: string;
  entityType: EntityType;
  entityId: string;
  action: AuditAction;
  oldStatus?: string | null;
  newStatus?: string | null;
  metadata?: Record<string, unknown>;
  actorType?: ActorType;
  actorId?: string | null;
}

/**
 * Insert an audit log entry. Fire-and-forget safe — callers may await or not.
 * Can be called within an existing transaction by passing the SQL in a txn context.
 */
export async function insertAuditLog(entry: AuditEntry): Promise<void> {
  await queryOne(
    `INSERT INTO payment_audit_log
       (organization_id, entity_type, entity_id, action, old_status, new_status, metadata, actor_type, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.organizationId,
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.oldStatus ?? null,
      entry.newStatus ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.actorType ?? 'SYSTEM',
      entry.actorId ?? null,
    ],
  );
}

/**
 * Build audit SQL + params for use inside a multi-statement transaction.
 * Returns [sql, params] tuple for manual execution within a pg transaction.
 */
export function buildAuditSql(entry: AuditEntry): [string, unknown[]] {
  const sql = `INSERT INTO payment_audit_log
    (organization_id, entity_type, entity_id, action, old_status, new_status, metadata, actor_type, actor_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
  const params = [
    entry.organizationId,
    entry.entityType,
    entry.entityId,
    entry.action,
    entry.oldStatus ?? null,
    entry.newStatus ?? null,
    JSON.stringify(entry.metadata ?? {}),
    entry.actorType ?? 'SYSTEM',
    entry.actorId ?? null,
  ];
  return [sql, params];
}
