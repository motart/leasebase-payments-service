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
  monthly_rent: number; // cents
  start_date: string;
  end_date: string;
  property_name: string | null;
  unit_number: string | null;
}

export interface LeaseForCheckout {
  lease_id: string;
  org_id: string;
  monthly_rent: number; // cents
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
    `SELECT l.id AS lease_id, l.monthly_rent, l.org_id
     FROM lease_service.leases l
     JOIN tenant_profiles tp ON tp.lease_id = l.id
     WHERE tp.user_id = $1 AND l.org_id = $2 AND l.status = 'ACTIVE'`,
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
       tp.user_id AS tenant_user_id,
       l.monthly_rent,
       l.start_date::text,
       l.end_date::text,
       p.name AS property_name,
       u.unit_number
     FROM lease_service.leases l
     LEFT JOIN tenant_profiles tp ON tp.lease_id = l.id
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
