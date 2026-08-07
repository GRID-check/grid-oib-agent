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
import { withTenant } from '@/lib/db/tenant-context'
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
