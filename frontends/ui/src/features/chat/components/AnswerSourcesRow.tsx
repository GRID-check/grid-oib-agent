/**
 * AnswerSourcesRow — the answer's single "Belegt durch" provenance block.
 *
 * ONE CHIP PER DOCUMENT. That is the whole design, and it is what the flat
 * shape could not express: an answer that leans on OIB-Richtlinie 2.1 at four
 * different pages is leaning on ONE Richtlinie, and a row that showed it four
 * times — three of them degraded to a raw filename with no authority badge —
 * both looked broken and overstated the breadth of the grounding.
 *
 * So a chip stands for a {@link CitedDocument}, and the `[N]` markers it
 * carries are listed on it. Every inline `[N]` in the prose anchors to the chip
 * of the document it belongs to, so a marker still leads somewhere; the
 * per-passage detail (which page, which excerpt, a copyable citation) lives ONE
 * CLICK AWAY in the chip's popover / document dialog, which is where it always
 * belonged.
 *
 * Nothing is fabricated: the row renders only sources the message already
 * carries (structured citations, the answer's own written sources section,
 * `legal_basis` cards). Colour comes from the canonical wire `kind` (ADR-0026)
 * refined by the lane, with an OIB/RIS/ÖNORM authority badge on top; every chip
 * carries icon + label + colour together, so colour is never the only carrier.
 */

'use client'

import { type CSSProperties, type FC } from 'react'
import { Globe } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  answerDocuments,
  citationNumbers,
  citedPages,
  refHost,
  type CitationRef,
  type CitedDocument,
} from '../lib/citations'
import { SourcePreviewChip } from './SourcePreview'
import { CopyCitationsMenu } from './CopyCitation'
import { useCitationScope } from './CitationScope'

interface AnswerSourcesRowProps {
  /**
   * The turn's citation model. Derived ONCE by the answer and passed in, so the
   * prose's inline markers and this row are reading the same objects — two
   * derivations of one citation is the defect the model exists to remove.
   */
  documents: CitedDocument[]
  /** DOM id prefix for the numbered anchors — per message, so ids stay unique. */
  anchorPrefix?: string
  /**
   * The turn's routing (WP-A). A substantive `shallow`/`deep` (or absent/legacy)
   * answer with zero sources gets the honest "Lücke" gap row; a `meta`/`error`
   * turn (conversational reply, error) does not — it makes no source claim.
   */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  /** While the answer is still streaming, sources arrive late — suppress the gap row. */
  isStreaming?: boolean
  /**
   * Draw the row's own top hairline. True in the inline answer variant, where
   * the row must separate itself from the prose above; false inside the
   * default card, whose answer body already ends in a hairline — the row
   * drawing a second one there produced the doubled line above the chips.
   */
  withDivider?: boolean
}

/**
 * How many chips the row shows before it stops. A summary, not a dump — but the
 * cap now bites far later than it used to, because collapsing a document's
 * pages onto one chip is exactly what stopped a four-page Richtlinie from
 * eating half the budget on its own.
 */
const MAX_ANSWER_SOURCES = 8

/** The quiet meta line after a chip: which pages, or which host. */
const useSourceMeta = (): ((doc: CitedDocument) => string | undefined) => {
  const t = useTranslations('chat')
  return (doc) => {
    const pages = citedPages(doc)
    if (pages.length === 1) return t('answerSources.page', { page: pages[0]! })
    if (pages.length > 1) return t('answerSources.pages', { pages: pages.join(', ') })
    return refHost({ document: doc })
  }
}

export const AnswerSourcesRow: FC<AnswerSourcesRowProps> = ({
  documents: allDocuments,
  anchorPrefix,
  routingDecision,
  isStreaming = false,
  withDivider = true,
}) => {
  const t = useTranslations('chat')
  const metaFor = useSourceMeta()
  const scope = useCitationScope()

  const documents = answerDocuments(allDocuments)
  // Never drop a document the prose numbered: dropping one would leave an
  // inline [N] pointing at an anchor that does not exist.
  const numbered = documents.filter((doc) => citationNumbers(doc).length > 0)
  const rest = documents.filter((doc) => citationNumbers(doc).length === 0)
  const shown = [...numbered, ...rest.slice(0, Math.max(0, MAX_ANSWER_SOURCES - numbered.length))]

  if (shown.length === 0) {
    // Honest "Lücke" treatment (design language §Domain-specific): a substantive
    // answer that cites nothing must say so in the neutral `--source-auto` gray
    // family, never hide its lack of grounding. Skipped for meta/error turns
    // (no source claim) and while still streaming.
    const isSubstantive = routingDecision !== 'meta' && routingDecision !== 'error'
    if (!isSubstantive || isStreaming) return null

    return (
      <div
        className={cn('flex flex-wrap items-center gap-1.5', withDivider && 'border-t pt-2')}
        role="note"
        aria-label={t('answerSources.gapAria')}
      >
        <span className="inline-flex items-center gap-1.5 rounded-md border border-source-auto/40 bg-source-auto-tint px-2 py-0.5 text-[11px] font-medium text-source-auto-text">
          <Globe className="size-3 shrink-0" aria-hidden="true" />
          {t('answerSources.gapLabel')}
        </span>
      </div>
    )
  }

  const refs: CitationRef[] = shown.map((doc) => ({ document: doc }))

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1.5', withDivider && 'border-t pt-2')}
      role="list"
      aria-label={t('answerSources.ariaLabel')}
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {t('answerSources.label')}
      </span>
      {shown.map((doc, docIndex) => {
        const numbers = citationNumbers(doc)
        // The chip the reader just asked about, from an inline [N] or a shared
        // link. Marking it is what turns "the page scrolled" into "THIS is the
        // source" — without it a marker click leaves you to guess where you
        // landed among eight near-identical chips.
        const isFocused = scope?.focused != null && numbers.includes(scope.focused)
        return (
        <span
          role="listitem"
          key={doc.id}
          data-focused={isFocused || undefined}
          className={cn(
            // `rounded-md`, matching the chip button inside: the highlight is
            // drawn on this wrapper, so a pill radius here traced a capsule
            // around a rounded rectangle — round on square, the shape of two
            // elements disagreeing rather than one element being marked.
            'inline-flex max-w-full scroll-mt-6 rounded-md',
            // Staggered entrance: the chips cascade in after the answer body
            // (which has its own fade/slide) instead of popping in as one
            // block. `animation-fill-mode: backwards` keeps a chip hidden
            // until its delay elapses — without it every chip flashes visible
            // first and animates after. A FOCUSED chip skips the entrance: it
            // belongs to an already-rendered message the reader jumped to, and
            // a delay there would stall the citation pulse that must fire now.
            !isFocused &&
              'animate-in fade-in-0 slide-in-from-bottom-1 duration-200 [animation-fill-mode:backwards] motion-reduce:animate-none',
            isFocused && 'animate-citation-pulse motion-reduce:animate-none'
          )}
          style={{
            ...(isFocused
              ? ({ ['--citation-pulse' as string]: `var(--source-${doc.tint})` } as CSSProperties)
              : { animationDelay: `${Math.min(docIndex, 6) * 40}ms` }),
          }}
        >
          {/* One anchor per [N] this document carries, all resolving to this
              chip. A document cited as [2] and [7] is one chip that both
              markers scroll to — which is the truth, and what the 1:1 shape
              could only fake by rendering the document twice. */}
          {anchorPrefix &&
            numbers.map((number) => (
              <span key={number} id={`${anchorPrefix}${number}`} className="scroll-mt-6" />
            ))}
          <SourcePreviewChip citation={{ document: doc }} meta={metaFor(doc)} />
        </span>
        )
      })}
      {/* Every source of this answer as a citation, in the format the user's
          own tooling reads. Quiet, at the end of the row. */}
      <CopyCitationsMenu citations={refs} />
    </div>
  )
}
