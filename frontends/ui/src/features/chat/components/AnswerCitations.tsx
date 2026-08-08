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
 * answer on screen sees the same parameter and stands down — by document
 * identity rather than position, and, when several answers cite the same
 * document, by a single claim so one link opens exactly one dialog.
 */

'use client'

import { useEffect, useRef, useSyncExternalStore, type FC, type ReactNode } from 'react'
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
 *
 * "The one holding it" is a claim, not a coincidence: a document cited by two
 * answers in the same conversation resolves in BOTH, and two dialogs for one
 * source stacked on top of each other is not a viewing session. The earliest
 * answer that actually holds the document owns the link ({@link claimLink});
 * the rest resolve it and stand down.
 */
const useLinkedCitation = (
  documents: CitedDocument[]
): { ref: CitationRef | null; dismiss: () => void } => {
  const params = useSearchParams()
  const value = params?.get(CITATION_PARAM) ?? null
  const claimant = useRef(0)
  if (claimant.current === 0) claimant.current = nextClaimant()
  const id = claimant.current
  const owner = useSyncExternalStore(subscribeToClaim, claimSnapshot, noOwner)

  const ref = value ? resolveCitationLink(parseCitationLink(value), documents) : null
  const holds = ref !== null

  useEffect(() => {
    if (!value || !holds) return
    claimLink(id, value)
    // Released on unmount so a link whose owner left the message list is picked
    // up by another answer holding the same document.
    return () => releaseLink(id, value)
  }, [value, holds, id])

  // Unowned — the previous owner unmounted — and this answer holds it.
  useEffect(() => {
    if (value && holds && !owner) claimLink(id, value)
  }, [value, holds, owner, id])

  return {
    ref: value && owner === claimKey(value, id) ? ref : null,
    dismiss: () => value && dismissLink(value),
  }
}

// ---------------------------------------------------------------------------
// Who owns the current `?cite=` link
// ---------------------------------------------------------------------------

/**
 * One claim on the link, outside React.
 *
 * The answers competing for it are siblings with no common owner below the chat
 * page, so the alternative is threading a provider through the message list for
 * a single string. There is only ever one link in the address bar, and both
 * facts about it — who is showing it and whether the reader is done with it —
 * belong to the LINK rather than to any one answer: a dismissal held per answer
 * would simply hand the dialog to the next answer that cites the document.
 */
const claim: { value: string | null; owner: number | null; dismissed: boolean } = {
  value: null,
  owner: null,
  dismissed: false,
}
const listeners = new Set<() => void>()

let claimants = 0
const nextClaimant = (): number => (claimants += 1)

const claimKey = (value: string, id: number): string => `${value}#${id}`
const noOwner = (): string => ''
const claimSnapshot = (): string =>
  claim.value !== null && claim.owner !== null && !claim.dismissed
    ? claimKey(claim.value, claim.owner)
    : ''

const subscribeToClaim = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const notify = (): void => listeners.forEach((listener) => listener())

/** Take the link, unless an earlier answer has this one or it was dismissed. */
const claimLink = (id: number, value: string): void => {
  // A different link is a new request (a second shared URL pasted into the bar),
  // so neither the previous owner's claim nor its dismissal carries over.
  if (claim.value !== value) {
    claim.value = value
    claim.owner = id
    claim.dismissed = false
    notify()
    return
  }
  if (claim.owner !== null || claim.dismissed) return
  claim.owner = id
  notify()
}

const releaseLink = (id: number, value: string): void => {
  if (claim.value !== value || claim.owner !== id) return
  claim.owner = null
  notify()
}

/** The reader closed the viewer: this link is spent until a new one arrives. */
const dismissLink = (value: string): void => {
  claim.value = value
  claim.owner = null
  claim.dismissed = true
  notify()
}
