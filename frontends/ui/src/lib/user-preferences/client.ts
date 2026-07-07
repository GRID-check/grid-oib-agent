/**
 * Client helpers for the per-user preferences store.
 *
 * Preferences live in the `user_preferences` table keyed by WorkOS user id and
 * are exposed through `/api/user/preferences`. The POST route merges its body
 * into the existing prefs, so callers only send the keys they want to change.
 *
 * All calls fail soft: when auth is disabled (REQUIRE_AUTH=false) the endpoint
 * returns 401, and preferences simply live in the cookie / localStorage layer
 * instead. Never let a preference write break the UI.
 */

'use client'

import type { Locale } from '@/i18n/config'
import type { ThemeMode } from '@/features/layout/types'

/** Shape of the keys Grid stores in user preferences. */
export interface UserPreferences {
  locale?: Locale
  theme?: ThemeMode
  activeProjectId?: string
  [key: string]: unknown
}

/** Read the current user's stored preferences. Returns `{}` on any failure. */
export async function fetchUserPreferences(): Promise<UserPreferences> {
  try {
    const res = await fetch('/api/user/preferences', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) return {}
    const data = (await res.json()) as { prefs?: UserPreferences }
    return data.prefs ?? {}
  } catch {
    return {}
  }
}

/**
 * Merge a patch into the current user's preferences. Fire-and-forget from the
 * caller's perspective: resolves to `true` on success, `false` otherwise.
 */
export async function patchUserPreferences(patch: Partial<UserPreferences>): Promise<boolean> {
  try {
    const res = await fetch('/api/user/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: patch }),
    })
    return res.ok
  } catch {
    return false
  }
}
