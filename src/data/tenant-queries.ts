/**
 * Cross-schema tenant queries.
 *
 * All reads from lease_service.lease_tenants / public."User" are isolated here.
 * Route handlers never write raw cross-schema SQL for tenant resolution.
 */
import { query, queryOne } from '@leasebase/service-common';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TenantLeaseLink {
  user_id: string;
  lease_id: string;
  org_id: string;
  email: string | null;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get all lease links for a tenant within an org.
 */
export async function getTenantLeaseLinks(
  userId: string,
  orgId: string,
): Promise<TenantLeaseLink[]> {
  return query<TenantLeaseLink>(
    `SELECT lt.tenant_id AS user_id, lt.lease_id, u."organizationId" AS org_id, u.email
     FROM lease_service.lease_tenants lt
     JOIN public."User" u ON lt.tenant_id = u.id
     WHERE lt.tenant_id = $1 AND u."organizationId" = $2`,
    [userId, orgId],
  );
}

/**
 * Check if a user owns a specific lease (tenant ownership guard).
 */
export async function tenantOwnsLease(
  userId: string,
  leaseId: string,
): Promise<boolean> {
  const row = await queryOne<{ tenant_id: string }>(
    `SELECT tenant_id FROM lease_service.lease_tenants WHERE tenant_id = $1 AND lease_id = $2`,
    [userId, leaseId],
  );
  return row !== null;
}

/**
 * Get tenant's email address.
 */
export async function getTenantEmail(userId: string): Promise<string | null> {
  const row = await queryOne<{ email: string }>(
    `SELECT email FROM public."User" WHERE id = $1`,
    [userId],
  );
  return row?.email ?? null;
}
