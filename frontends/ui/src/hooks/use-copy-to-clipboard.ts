'use client'

import { useCallback } from 'react'
import { useTransientFlag } from './use-transient-flag'

/**
 * Copy text and hold a short-lived `copied` flag for the acknowledgement.
 *
 * The one clipboard copy for a button that says "copied": `CopyField`,
 * `CodeBlock`, the citation link, the support reference and the user message
 * all use it. The flag is {@link useTransientFlag}'s, so its timer is cleared
 * on unmount and restarted by a second copy: a quick double click does not
 * drop the acknowledgement early.
 *
 * `copy` resolves `false` when the Clipboard API is missing or refuses
 * (insecure context, denied permission), so the caller can say so instead of
 * showing "copied" for a copy that never happened.
 */
export function useCopyToClipboard(): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, flashCopied] = useTransientFlag()

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        return false
      }
      flashCopied()
      return true
    },
    [flashCopied]
  )

  return { copied, copy }
}
