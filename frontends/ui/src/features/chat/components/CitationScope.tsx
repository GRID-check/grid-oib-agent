/**
 * One answer's citations, shared by the two places that render them.
 *
 * The prose and the provenance row are the same claim seen twice: `[3]` in a
 * sentence and the chip it points at are one citation. They sit in different
 * component subtrees, so without a shared scope each would have to derive the
 * model again — and two derivations of one citation is precisely the defect the
 * model was built to remove.
 *
 * The scope also carries the FOCUS: which `[N]` the reader just activated. That
 * is what lets the chip mark itself when a marker is clicked, turning "the page
 * moved" into "this is the source you asked about".
 */

'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react'
import { citationNumbers, type CitedDocument, type CitationRef } from '../lib/citations'

interface CitationScopeValue {
  documents: CitedDocument[]
  /** DOM id prefix this answer's numbered anchors use. */
  anchorPrefix: string
  /** The reference a given `[N]` names, or undefined when the answer has none. */
  referenceFor: (number: number) => CitationRef | undefined
  /** The `[N]` currently marked, or null. */
  focused: number | null
  /** Mark an `[N]` — clears itself shortly after, so it reads as a cue, not a mode. */
  focus: (number: number) => void
}

const CitationScopeContext = createContext<CitationScopeValue | null>(null)

/** How long a marked chip stays marked. Long enough to notice, short enough not to nag. */
const FOCUS_MS = 2200

export const CitationScope: FC<{
  documents: CitedDocument[]
  anchorPrefix: string
  children: ReactNode
}> = ({ documents, anchorPrefix, children }) => {
  const [focused, setFocused] = useState<number | null>(null)
  const timer = useRef<number | null>(null)

  const focus = useCallback((number: number) => {
    setFocused(number)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setFocused(null), FOCUS_MS)
  }, [])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  const value = useMemo<CitationScopeValue>(() => {
    // `[N]` → the document carrying it, and the locus that carries it exactly.
    // Built once per document set rather than scanned per marker, because an
    // answer can hold a lot of markers and they all resolve on render.
    const byNumber = new Map<number, CitationRef>()
    for (const document of documents) {
      for (const locus of document.loci) {
        if (typeof locus.number === 'number') byNumber.set(locus.number, { document, locus })
      }
      // A document whose number is known only at the document level (no locus
      // carries it) still resolves — to the document as a whole.
      for (const number of citationNumbers(document)) {
        if (!byNumber.has(number)) byNumber.set(number, { document })
      }
    }
    return {
      documents,
      anchorPrefix,
      referenceFor: (number: number) => byNumber.get(number),
      focused,
      focus,
    }
  }, [documents, anchorPrefix, focused, focus])

  return <CitationScopeContext.Provider value={value}>{children}</CitationScopeContext.Provider>
}

/** The enclosing answer's citations, or null outside one. */
export const useCitationScope = (): CitationScopeValue | null => useContext(CitationScopeContext)
