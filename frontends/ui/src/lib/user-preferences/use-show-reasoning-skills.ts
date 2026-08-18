'use client'

/**
 * The "show hidden skills in the reasoning view" preference, as a hook.
 *
 * Mirrors the theme-preference sync in `app/providers.tsx`: hydrate once from
 * the signed-in user's stored prefs so the choice follows them across devices,
 * then persist any change back. Both directions fail soft — with auth disabled
 * the endpoint 401s and the toggle simply lives in memory for the session.
 *
 * The default is CLOSED (`SHOW_REASONING_SKILLS_DEFAULT`): a `grid-hidden`
 * skill is kept out of the noisy live line unless the reader opts in. It is
 * never concealed — the activation still records and the disclosure still names
 * it — so turning this off loses a line, not a trace.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  SHOW_REASONING_SKILLS_DEFAULT,
  fetchUserPreferences,
  readShowReasoningSkills,
  setShowReasoningSkills,
} from './client'

export interface ShowReasoningSkillsState {
  /** Whether hidden-skill activations are surfaced in the reasoning view. */
  showReasoningSkills: boolean
  /** True until the first hydration settles; the toggle should read as pending. */
  loading: boolean
  /** Set the preference and persist it (optimistic; the write is fail-soft). */
  setShowReasoningSkills: (value: boolean) => void
}

export function useShowReasoningSkills(): ShowReasoningSkillsState {
  const [value, setValue] = useState<boolean>(SHOW_REASONING_SKILLS_DEFAULT)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void fetchUserPreferences()
      .then((prefs) => {
        if (!cancelled) setValue(readShowReasoningSkills(prefs))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = useCallback((next: boolean) => {
    // Optimistic: the UI reflects the choice immediately, and the persist is
    // fire-and-forget — a lost write costs the cross-device carry, not the toggle.
    setValue(next)
    void setShowReasoningSkills(next)
  }, [])

  return { showReasoningSkills: value, loading, setShowReasoningSkills: update }
}
