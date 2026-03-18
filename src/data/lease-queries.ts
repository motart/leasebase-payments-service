/**
 * Cross-schema lease queries.
 *
 * All reads from lease_service schema are isolated here.
 * Route handlers and domain logic NEVER write raw cross-schema SQL.
 * This creates a replaceable seam for future event-driven sync or HTTP calls.
 */
import { query, queryOne } from '@leasebase/service-common';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActiveLeaseForBilling {
  lease_id: string;
  org_id: string;
  tenant_user_id: string | null;
  rent_amount: number | null; // cents — sourced from leases.rent_amount (canonical); null if not configured
  start_date: string;
  end_date: string;
  property_name: string | null;
  unit_number: string | null;
}

export interface LeaseForCheckout {
  lease_id: string;
  org_id: string;
  rent_amount: number | null; // cents — sourced from leases.rent_amount (canonical); null if not configured
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get the active lease for a tenant within an org (for checkout flow).
 */
export async function getActiveLeaseForTenant(
  userId: string,
  orgId: string,
): Promise<LeaseForCheckout | null> {
  return queryOne<LeaseForCheckout>(
    `SELECT l.id AS lease_id, l.rent_amount, l.org_id
     FROM lease_service.leases l
     JOIN lease_service.lease_tenants lt ON lt.lease_id = l.id
     WHERE lt.tenant_id = $1 AND l.org_id = $2 AND l.status = 'ACTIVE'`,
    [userId, orgId],
  );
}

/**
 * Get all active leases eligible for charge generation on a given billing date.
 * Returns leases where:
 *  - status is ACTIVE
 *  - start_date <= billingDate
 *  - end_date >= billingDate (or end_date is null for month-to-month)
 */
export async function getActiveLeasesForChargeGeneration(
  billingDate: Date,
): Promise<ActiveLeaseForBilling[]> {
  const dateStr = billingDate.toISOString().split('T')[0]; // YYYY-MM-DD
  return query<ActiveLeaseForBilling>(
    `SELECT
       l.id AS lease_id,
       l.org_id,
       payer.tenant_id AS tenant_user_id,
       l.rent_amount,
       l.start_date::text,
       l.end_date::text,
       p.name AS property_name,
       u.unit_number
     FROM lease_service.leases l
     LEFT JOIN LATERAL (
       SELECT lt.tenant_id
       FROM lease_service.lease_tenants lt
       WHERE lt.lease_id = l.id
       ORDER BY CASE WHEN lt.role = 'PRIMARY' THEN 0 ELSE 1 END, lt.created_at ASC
       LIMIT 1
     ) payer ON true
     LEFT JOIN property_service.properties p ON l.property_id::text = p.id::text
     LEFT JOIN property_service.units u ON l.unit_id::text = u.id::text
     WHERE l.status = 'ACTIVE'
       AND l.start_date <= $1::date
       AND (l.end_date IS NULL OR l.end_date >= $1::date)`,
    [dateStr],
  );
}

/**
 * Get lease + property details for a given lease (used for receipt generation).
 */
export async function getLeaseDetails(
  leaseId: string,
): Promise<{ property_name: string | null; unit_number: string | null } | null> {
  return queryOne<{ property_name: string | null; unit_number: string | null }>(
    `SELECT
       p.name AS property_name,
       u.unit_number
     FROM lease_service.leases l
     LEFT JOIN property_service.properties p ON l.property_id::text = p.id::text
     LEFT JOIN property_service.units u ON l.unit_id::text = u.id::text
     WHERE l.id = $1`,
    [leaseId],
  );
}
