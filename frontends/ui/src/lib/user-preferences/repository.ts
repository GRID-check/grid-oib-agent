/**
 * User-preferences repository — the only module that talks to the
 * `user_preferences` table. Rows are keyed by WorkOS user id; the prefs bag
 * is opaque JSON owned by the client.
 */

import 'server-only'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { userPreferences } from '@/lib/db/schema'

export async function findUserPreferences(workosUserId: string): Promise<Record<string, unknown> | null> {
  const db = getDb()
  const [row] = await db
    .select({ prefs: userPreferences.prefs })
    .from(userPreferences)
    .where(eq(userPreferences.workosUserId, workosUserId))
    .limit(1)
  return (row?.prefs as Record<string, unknown> | undefined) ?? null
}

export async function upsertUserPreferences(
  workosUserId: string,
  prefs: Record<string, unknown>,
): Promise<void> {
  const db = getDb()
  await db
    .insert(userPreferences)
    .values({ workosUserId, prefs })
    .onConflictDoUpdate({
      target: userPreferences.workosUserId,
      set: { prefs },
    })
}
