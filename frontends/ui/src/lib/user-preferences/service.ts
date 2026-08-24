/**
 * User-preferences service — opaque per-user preferences such as the active
 * project id. Always self-scoped: rows are read and written under the
 * session's own user id, never a caller-supplied one.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findUserPreferences, upsertUserPreferences } from './repository'

export async function getUserPreferences(session: AuthorizedSession): Promise<Record<string, unknown>> {
  return (await findUserPreferences(session.userId, session.organizationId)) ?? {}
}

/**
 * Merge a patch into the user's existing prefs (read-merge-upsert), so
 * callers can update a single key (e.g. locale) without clobbering the rest
 * (e.g. theme, active project). Returns the merged bag.
 */
export async function mergeUserPreferences(
  session: AuthorizedSession,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const existing = (await findUserPreferences(session.userId, session.organizationId)) ?? {}
  const merged = { ...existing, ...patch }
  await upsertUserPreferences(session.userId, session.organizationId, merged)
  return merged
}
