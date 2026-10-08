/**
 * The composer's screen for a chat message (ADR-0085, "Chat messages are
 * screened too"): the office's content terms and detectors, run on the text
 * before it leaves the browser.
 *
 * Synchronous at send time on purpose. The policy is read once when the
 * composer mounts (`loadUploadScreeningPolicy`), so pressing Enter is never
 * an await that a second Enter could overtake. Until it has arrived, and
 * whenever it cannot be read, Piloti's suggested list applies: a privacy
 * control fails closed, and the chat socket masks with the office's own list
 * again in any case. Uploads do not fall back like this; they wait for the
 * office's list or send nothing.
 */

import { useCallback, useEffect, useState } from 'react'
import { loadUploadScreeningPolicy } from '@/adapters/api/upload-screening-policy'
import {
  chatScreeningRules,
  maskText,
  type ContentScreenRules,
  type MaskedText,
} from '@/lib/upload-screening/content-screen'
import { SUGGESTED_SCREENING_POLICY } from '@/lib/upload-screening/policy'

/** `screen(text)`: the text masked against the office's policy, and what was found. */
export function useChatScreening(): (text: string) => MaskedText {
  const [rules, setRules] = useState<ContentScreenRules | null>(() =>
    chatScreeningRules(SUGGESTED_SCREENING_POLICY)
  )

  useEffect(() => {
    let live = true
    loadUploadScreeningPolicy().then(
      (policy) => {
        if (live) setRules(chatScreeningRules(policy))
      },
      () => {
        // Piloti's suggestion stays in force; see above.
      }
    )
    return () => {
      live = false
    }
  }, [])

  return useCallback((text: string) => maskText(text, rules), [rules])
}
