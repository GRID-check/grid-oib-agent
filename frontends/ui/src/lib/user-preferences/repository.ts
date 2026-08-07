/**
 * User-preferences repository — the only module that talks to the
 * `user_preferences` table. Rows are keyed by WorkOS user id; the prefs bag
 * is opaque JSON owned by the client.
 */

import 'server-only'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withOptionalTenant, withTenant } from '@/lib/db/tenant-context'
import { userPreferences } from '@/lib/db/schema'

export async function findUserPreferences(
  workosUserId: string,
  organizationId: string,
): Promise<Record<string, unknown> | null> {
  const db = getDb()
  // The `user_preferences` policy is `workos_user_id = grid_current_user_id()`,
  // so the scope has to carry the USER, not just the organization.
  const [row] = await withTenant({ organizationId, userId: workosUserId }, () =>
    db
      .select({ prefs: userPreferences.prefs })
      .from(userPreferences)
      .where(eq(userPreferences.workosUserId, workosUserId))
      .limit(1),
  )
  return (row?.prefs as Record<string, unknown> | undefined) ?? null
}

export async function upsertUserPreferences(
  workosUserId: string,
  organizationId: string,
  prefs: Record<string, unknown>,
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId, userId: workosUserId }, () =>
    db
      .insert(userPreferences)
      .values({ workosUserId, prefs })
      .onConflictDoUpdate({
        target: userPreferences.workosUserId,
        set: { prefs },
      }),
  )
}

/**
 * The prefs bag for a user whose session may have no organization selected.
 *
 * The tenant variant of {@link findUserPreferences}: anonymous single-tenant
 * deployments reach this with no organization, which is what
 * `withOptionalTenant` covers. The row is still keyed by user either way.
 */
export async function findUserPreferencesForSession(
  workosUserId: string,
  organizationId: string | null | undefined,
): Promise<Record<string, unknown> | null> {
  const db = getDb()
  const [row] = await withOptionalTenant(
    organizationId,
    'active-project preference lookup for a session with no organization selected',
    () =>
      db
        .select({ prefs: userPreferences.prefs })
        .from(userPreferences)
        .where(eq(userPreferences.workosUserId, workosUserId))
        .limit(1),
  )
  return (row?.prefs as Record<string, unknown> | undefined) ?? null
}
