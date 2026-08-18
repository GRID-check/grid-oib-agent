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
  /**
   * Surface HIDDEN skills' activations in the reasoning / Herleitung detail.
   *
   * A `grid-hidden` skill (a house voice, say) is kept out of the noisy live
   * line by default — its activation event is routed to the technical channel
   * (backend `events.py`). It is never concealed: it still records, the
   * `SkillsUsedDisclosure` still names it, and turning this ON reveals those
   * technical-channel activations in the reasoning view. Default OFF — the
   * whole point of hidden is a quieter default line, not a hidden trace.
   */
  showReasoningSkills?: boolean
  [key: string]: unknown
}

/** Default for {@link readShowReasoningSkills}: hidden skills stay out of the live line. */
export const SHOW_REASONING_SKILLS_DEFAULT = false

/**
 * Read the reasoning-skills preference off a prefs bag, defaulting closed.
 *
 * A non-boolean stored value (a corrupt bag, a hand-edited row) reads as the
 * default rather than throwing — a preference must never break the surface it
 * decorates.
 */
export function readShowReasoningSkills(prefs: UserPreferences | null | undefined): boolean {
  return typeof prefs?.showReasoningSkills === 'boolean'
    ? prefs.showReasoningSkills
    : SHOW_REASONING_SKILLS_DEFAULT
}

/**
 * Persist the reasoning-skills preference. Fire-and-forget, fail-soft: resolves
 * `true` on success, `false` otherwise, exactly like {@link patchUserPreferences}.
 */
export async function setShowReasoningSkills(value: boolean): Promise<boolean> {
  return patchUserPreferences({ showReasoningSkills: value })
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
