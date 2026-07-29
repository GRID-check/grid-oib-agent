/**
 * The wrapper that makes an answer's citations interactive.
 *
 * Two things have to be true at once for a citation to feel like one object:
 * the inline `[3]` and the chip under the answer must READ the same model
 * ({@link CitationScope}), and the markdown renderer must be willing to hand
 * its in-page anchors to something that knows what they mean
 * ({@link InPageAnchorProvider}).
 *
 * It also honours a shared link: arriving with `?cite=…` opens the named
 * document at the named page, in the answer that actually holds it. Every other
 * answer on screen sees the same parameter and correctly ignores it, because
 * resolution is by document identity, not by position.
 */

'use client'

import { useEffect, useState, type FC, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { InPageAnchorProvider } from '@/shared/components/MarkdownRenderer/anchor-context'
import {
  CITATION_PARAM,
  parseCitationLink,
  resolveCitationLink,
  type CitationRef,
  type CitedDocument,
} from '../lib/citations'
import { CitationScope } from './CitationScope'
import { CitationMarker } from './CitationMarker'
import { SourceDocumentDialog } from './SourcePreview'

export const AnswerCitations: FC<{
  documents: CitedDocument[]
  anchorPrefix: string
  children: ReactNode
}> = ({ documents, anchorPrefix, children }) => {
  const linked = useLinkedCitation(documents)

  return (
    <CitationScope documents={documents} anchorPrefix={anchorPrefix}>
      <InPageAnchorProvider
        render={({ href, children: label }) => (
          <CitationMarker
            href={href}
            fallback={
              // Not one of this answer's citations — a heading link the model
              // wrote. Keep the plain scroll anchor rather than dressing up
              // something we cannot describe.
              <a href={href} className="text-brand underline underline-offset-2 hover:opacity-80">
                {label}
              </a>
            }
          />
        )}
      >
        {children}
      </InPageAnchorProvider>
      {linked.ref && (
        <SourceDocumentDialog citation={linked.ref} onClose={linked.dismiss} />
      )}
    </CitationScope>
  )
}

/**
 * The citation this page was linked to, if this answer is the one holding it.
 *
 * Opened once per arrival: dismissing must not immediately reopen it, and the
 * URL is deliberately left alone so a reload still lands in the same place —
 * the link is an address, and rewriting it out from under the reader would make
 * the back button lie.
 */
const useLinkedCitation = (
  documents: CitedDocument[]
): { ref: CitationRef | null; dismiss: () => void } => {
  const params = useSearchParams()
  const value = params?.get(CITATION_PARAM) ?? null
  const [dismissed, setDismissed] = useState<string | null>(null)

  // A new link while the page is open (a second shared URL pasted into the bar)
  // is a fresh request, so the previous dismissal no longer applies.
  useEffect(() => {
    setDismissed((current) => (current === value ? current : null))
  }, [value])

  if (!value || dismissed === value) return { ref: null, dismiss: () => setDismissed(value) }
  return {
    ref: resolveCitationLink(parseCitationLink(value), documents),
    dismiss: () => setDismissed(value),
  }
}
