'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the "copied" acknowledgement stays up. */
const COPIED_MS = 1500

/**
 * Copy text and hold a short-lived `copied` flag for the acknowledgement.
 *
 * The one clipboard copy for a button that says "copied": `CopyField`,
 * `CodeBlock`, the citation link, the support reference and the user message
 * all use it. Each used to carry its own `setTimeout` that outlived an
 * unmounted component and cut a second click's acknowledgement short.
 *
 * `copy` resolves `false` when the Clipboard API is missing or refuses
 * (insecure context, denied permission), so the caller can say so instead of
 * showing "copied" for a copy that never happened. The timer is cleared on
 * unmount and restarted by a second copy, so a quick double click does not
 * drop the acknowledgement early.
 */
export function useCopyToClipboard(): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  const copy = useCallback(async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return false
    }
    if (timer.current !== null) window.clearTimeout(timer.current)
    setCopied(true)
    timer.current = window.setTimeout(() => {
      timer.current = null
      setCopied(false)
    }, COPIED_MS)
    return true
  }, [])

  return { copied, copy }
}
