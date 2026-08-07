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
 * Every organization's settings row — the platform-owner read (ADR-0042).
 *
 * The one query in this module that is NOT tenant-scoped, so it goes through
 * `withPlatformAccess` rather than `withTenant`: crossing the RLS boundary has
 * to be explicit and has to say why. Reachable only from platform-tier callers.
 *
 * Returns only organizations Grid has written a row for. WorkOS remains the
 * directory, so an org that has never changed a setting will be absent — callers
 * that need the full roster must merge with WorkOS themselves.
 */
export async function findOrganizations(): Promise<Organization[]> {
  const db = getDb()
  return withPlatformAccess('platform storage: settings rows for every organization', () =>
    db.select().from(organizations),
  )
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
