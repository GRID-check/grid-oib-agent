/**
 * Organization instructions repository — the only module that queries
 * `organization_instructions`.
 *
 * Repository rules (ADR-0017, `docs/architecture/bff-service-architecture.md`):
 * drizzle only, no HTTP, no auth, no WorkOS; every query takes an
 * `organizationId`, scopes its WHERE clause with it, and runs in that
 * organization's tenant context. The table is a single row per organization, so
 * there is no list read here and nothing to bound.
 */

import 'server-only'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { organizationInstructions, type OrganizationInstructions } from '@/lib/db/schema'

/** The stored block for an organization, or null when it has never written one. */
export async function findOrganizationInstructions(
  organizationId: string,
): Promise<OrganizationInstructions | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(organizationInstructions)
      .where(eq(organizationInstructions.organizationId, organizationId))
      .limit(1),
  )
  return row ?? null
}

/**
 * Write the block, replacing whatever was there.
 *
 * An upsert rather than an insert-or-update pair: the row's identity is the
 * organization, so there is no version to keep and nothing an interleaved
 * second save could half-apply. The CHECKs in 0087 are what refuse an
 * over-length or blank value; this function does not re-state them, because a
 * bound restated in two layers is a bound that can disagree with itself.
 */
export async function upsertOrganizationInstructions(values: {
  organizationId: string
  instructions: string
  updatedBy: string
  updatedByEmail: string | null
}): Promise<OrganizationInstructions> {
  const db = getDb()
  const row = {
    instructions: values.instructions,
    updatedBy: values.updatedBy,
    updatedByEmail: values.updatedByEmail,
    updatedAt: new Date(),
  }
  const [saved] = await withTenant({ organizationId: values.organizationId }, () =>
    db
      .insert(organizationInstructions)
      .values({ organizationId: values.organizationId, ...row })
      .onConflictDoUpdate({ target: organizationInstructions.organizationId, set: row })
      .returning(),
  )
  return saved
}

/**
 * Remove the block. Clearing the text is a DELETE, not an empty string, so
 * "never written" and "written, then emptied" stay one state (see the schema
 * module for why that matters on the header path).
 */
export async function deleteOrganizationInstructions(organizationId: string): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .delete(organizationInstructions)
      .where(eq(organizationInstructions.organizationId, organizationId)),
  )
}
