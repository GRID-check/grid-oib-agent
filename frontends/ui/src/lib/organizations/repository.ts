/**
 * Organizations repository — the only module that talks to the `organizations`
 * table (Grid's own per-org settings row; WorkOS remains the directory).
 *
 * Repository rules (see docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no WorkOS.
 *   - Every query takes `organizationId`, scopes the WHERE clause with it, and
 *     runs in that organization's tenant context.
 */

import 'server-only'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { organizations, type Organization } from '@/lib/db/schema'

/** The stored settings row for an organization, or null before its first write. */
export async function findOrganization(organizationId: string): Promise<Organization | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(organizations)
      .where(eq(organizations.workosOrganizationId, organizationId))
      .limit(1),
  )
  return row ?? null
}

/**
 * How many organization rows one platform read may return.
 *
 * A cap rather than a cursor, and the number is the argument: the whole point of
 * the platform storage page is to compare tenants against each other, ordered by
 * consumption, and consumption is an aggregate over another table. A cursor over
 * that ordering would have to move the sort into SQL and page a join — real work,
 * for a fleet that is two orders of magnitude smaller than this bound. So the
 * query is bounded (the repo rule), the caller is told when it truncated, and the
 * day this cap is reached is the day the join is worth writing.
 */
export const ORGANIZATION_PAGE_MAX = 1000

/** A bounded page of organization rows, and whether it left any behind. */
export interface OrganizationPage {
  organizations: Organization[]
  truncated: boolean
}

/**
 * Organization settings rows — the platform-owner read (ADR-0042). BOUNDED.
 *
 * The one query in this module that is NOT tenant-scoped, so it goes through
 * `withPlatformAccess` rather than `withTenant`: crossing the RLS boundary has
 * to be explicit and has to say why. Reachable only from platform-tier callers.
 *
 * Reads `limit + 1` rows to answer "is there more?" without a second `count(*)`
 * over the whole table, and returns at most `limit`.
 *
 * Returns only organizations Grid has written a row for. WorkOS remains the
 * directory, so an org that has never changed a setting will be absent — callers
 * that need the full roster must merge with WorkOS themselves.
 */
export async function findOrganizations(
  limit: number = ORGANIZATION_PAGE_MAX,
): Promise<OrganizationPage> {
  const db = getDb()
  const capped = Math.max(1, Math.min(limit, ORGANIZATION_PAGE_MAX))

  const rows = await withPlatformAccess(
    'platform storage: settings rows for every organization',
    () =>
      db
        .select()
        .from(organizations)
        .orderBy(organizations.workosOrganizationId)
        .limit(capped + 1),
  )

  return { organizations: rows.slice(0, capped), truncated: rows.length > capped }
}

/** Insert or update the whole settings row. The service owns the merge. */
export async function upsertOrganization(values: {
  organizationId: string
  displayName: string | null
  defaultLocale: string
  settings: Record<string, unknown>
}): Promise<void> {
  const db = getDb()
  const row = {
    displayName: values.displayName,
    defaultLocale: values.defaultLocale,
    settings: values.settings,
    updatedAt: new Date(),
  }
  await withTenant({ organizationId: values.organizationId }, () =>
    db
      .insert(organizations)
      .values({ workosOrganizationId: values.organizationId, ...row })
      .onConflictDoUpdate({ target: organizations.workosOrganizationId, set: row }),
  )
}
