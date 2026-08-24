'use client'

/**
 * The skills the composer's `/` menu can offer.
 *
 * Simpler than `useMentionCandidates` by nature rather than by omission: the
 * mention list is per-conversation and races the thread's first persisted
 * message, so it needs a retry ladder. The invocable list is per-ORGANISATION
 * and exists before any conversation does, so one fetch is the whole story.
 *
 * Fetched lazily — nothing is requested until the user actually types `/` —
 * and then kept for the life of the composer, because the panel has to filter
 * on every keystroke and a request per keystroke would make the menu lag behind
 * the text that drives it. A skill authored in another tab therefore appears
 * after a reload; that is the right trade for a list that changes rarely and is
 * read constantly.
 */

import { useEffect, useRef, useState } from 'react'
import { listInvocableSkills, type InvocableSkill } from '@/adapters/api/skills-client'

export interface InvocableSkillsState {
  skills: InvocableSkill[]
  loading: boolean
  /** True once a fetch has settled, successfully or not. */
  loaded: boolean
  /**
   * Whether the feature answered at all.
   *
   * The distinction matters at the composer: a successful fetch returning zero
   * skills is an org that HAS the feature and has authored nothing yet, and it
   * should see the panel's empty state, which is the only place the product
   * explains what a skill is. A failed fetch — the feature gated off, or the
   * request lost — must instead leave the composer behaving exactly as it did
   * before this feature existed, with `/` as an ordinary character.
   */
  available: boolean
}

export function useInvocableSkills(enabled: boolean): InvocableSkillsState {
  const [skills, setSkills] = useState<InvocableSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [available, setAvailable] = useState(false)
  // One fetch per mount, even though `enabled` flips on every `/` the user types.
  const requested = useRef(false)

  useEffect(() => {
    if (!enabled || requested.current) return
    requested.current = true
    let cancelled = false

    setLoading(true)
    listInvocableSkills()
      .then((result) => {
        if (cancelled) return
        setSkills(result)
        setAvailable(true)
      })
      .catch(() => {
        // Fail quiet, and fail EMPTY. The menu is an accelerator for something
        // the user can also just write out in prose, so a failed fetch shows the
        // "no skills" panel rather than an error the composer would have to
        // explain mid-sentence. `loaded` still flips, so the panel stops
        // claiming to be loading.
        if (cancelled) return
        setSkills([])
        setAvailable(false)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        setLoaded(true)
      })

    return () => {
      cancelled = true
    }
  }, [enabled])

  return { skills, loading, loaded, available }
}
