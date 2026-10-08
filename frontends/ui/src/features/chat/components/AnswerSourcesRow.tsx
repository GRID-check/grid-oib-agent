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
 * carries (structured citations, the answer's own written sources section).
 * Colour comes from the canonical wire `kind` (ADR-0026)
 * refined by the lane, with an OIB/RIS/ÖNORM authority badge on top; every chip
 * carries icon + label + colour together, so colour is never the only carrier.
 */

'use client'

import { useState, type CSSProperties, type FC } from 'react'
import { Globe, Lock } from 'lucide-react'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  answerDocuments,
  citationNumbers,
  documentPages,
  refHost,
  type CitationRef,
  type CitedDocument,
} from '../lib/citations'
import { useChatStore } from '../store'
import { isPrecedent } from '../lib/precedent'
import { SourcePreviewChip } from './SourcePreview'
import { CopyCitationsMenu } from './CopyCitation'
import { useCitationScope } from './CitationScope'
import { useCurrentProject } from '@/features/projects/lib/current-project'

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

/**
 * The quiet meta line after a chip: which pages, or which host. A project file
 * from a closed project also names the project and that it is closed
 * (ADR-0082): the chat's own project's file when the chat's project is closed,
 * or a file a cross-project lookup found in another project that is
 * (ADR-0085), by that project's own status, whatever the chat's.
 */
const useClosedProjectNote = (): ((doc: CitedDocument) => string | null) => {
  const tProjects = useTranslations('projects')
  const current = useCurrentProject()
  return (doc) => {
    if (doc.kind !== 'projekt') return null
    // The chip's label already names another project's file's project.
    if (doc.project) return doc.project.status === 'closed' ? tProjects('lifecycle.fileChipNoName') : null
    return current?.status === 'closed' ? tProjects('lifecycle.fileChip', { name: current.name }) : null
  }
}

/**
 * The meta line of a precedent (ADR-0085): its project by name, that project's
 * own status, and the Land the agent stated for it, warning included.
 */
const usePrecedentNote = (): ((doc: CitedDocument) => string | null) => {
  const t = useTranslations('chat')
  // The same chat project the chip's popover compares against (SourcePreviewChip).
  const chatProjectId = useChatStore((s) => s.projectId)
  return (doc) => {
    if (!doc.project || !isPrecedent(doc, chatProjectId)) return null
    const { name, status, landNote } = doc.project
    const named = t('answerSources.precedentProject', {
      name,
      status: t(`answerSources.projectStatus.${status}`),
    })
    return landNote ? `${named} · ${landNote}` : named
  }
}

const useSourceMeta = (): ((doc: CitedDocument) => string | undefined) => {
  const t = useTranslations('chat')
  const closedNoteFor = useClosedProjectNote()
  const precedentNoteFor = usePrecedentNote()
  return (doc) => {
    const pages = documentPages(doc)
    const base =
      pages.length === 1
        ? t('answerSources.page', { page: pages[0]! })
        : pages.length > 1
          ? t('answerSources.pages', { pages: pages.join(', ') })
          : refHost({ document: doc })
    const note = precedentNoteFor(doc) ?? closedNoteFor(doc)
    if (!note) return base
    return base ? `${base} · ${note}` : note
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
  const closedNoteFor = useClosedProjectNote()
  const scope = useCitationScope()

  const [expanded, setExpanded] = useState(false)
  const documents = answerDocuments(allDocuments)
  // Never drop a document the prose numbered: dropping one would leave an
  // inline [N] pointing at an anchor that does not exist.
  const numbered = documents.filter((doc) => citationNumbers(doc).length > 0)
  const rest = documents.filter((doc) => citationNumbers(doc).length === 0)
  const folded = Math.max(0, MAX_ANSWER_SOURCES - numbered.length)
  const shown = expanded ? documents : [...numbered, ...rest.slice(0, folded)]
  const hidden = documents.length - shown.length
  // Citation chips always wear their lane tints: lane tint is provenance
  // (where it stands), not decoration — washes/alarms spend the hue budget
  // elsewhere, never by muting the source signal. Grey chips read as broken,
  // so the documents pass through untouched, tint and all.
  const display: CitedDocument[] = shown

  if (shown.length === 0) {
    // Honest "Lücke" treatment (design language §Domain-specific): a substantive
    // answer that cites nothing must say so in the neutral `--source-auto` gray
    // family, never hide its lack of grounding. Skipped for meta/error turns
    // (no source claim). While streaming, reserve the chip-row height so the
    // late-arriving chips (or the gap row) do not grow the footer.
    const isSubstantive = routingDecision !== 'meta' && routingDecision !== 'error'
    if (!isSubstantive) return null
    if (isStreaming) {
      return <div className={cn('min-h-6', withDivider && 'border-t pt-2')} aria-hidden="true" />
    }

    return (
      <div
        className={cn(
          'flex min-h-6 flex-wrap items-center gap-1.5',
          withDivider && 'border-t pt-2'
        )}
        role="note"
        aria-label={t('answerSources.gapAria')}
      >
        <span className="border-source-auto/40 bg-source-auto-tint text-source-auto-text inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium">
          <Globe className="size-3 shrink-0" aria-hidden="true" />
          {t('answerSources.gapLabel')}
        </span>
      </div>
    )
  }

  // Every document, not the shown ones: „Alle Quellen kopieren" is a claim about
  // the answer, and a fold is a claim about the screen.
  const refs: CitationRef[] = documents.map((doc) => ({ document: doc }))

  return (
    <div
      className={cn('flex min-h-6 flex-wrap items-center gap-1.5', withDivider && 'border-t pt-2')}
      role="list"
      aria-label={t('answerSources.ariaLabel')}
    >
      <SectionLabel>{t('answerSources.label')}</SectionLabel>
      {display.map((doc) => {
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
              // Single fade for the whole row after the answer body (which has
              // its own fade/slide) instead of a per-chip cascade: the stagger
              // held late chips invisible behind `backwards` fill for up to
              // ~200ms to communicate an ordering nobody was counting, and every
              // chip flashing in sequence drew the eye down the row instead of
              // to the prose. A FOCUSED chip skips the entrance: it
              // belongs to an already-rendered message the reader jumped to, and
              // a delay there would stall the citation pulse that must fire now.
              !isFocused &&
                'animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-entrance [animation-fill-mode:backwards] motion-reduce:animate-none',
              isFocused && 'animate-citation-pulse motion-reduce:animate-none'
            )}
            style={
              isFocused
                ? ({ ['--citation-pulse' as string]: `var(--source-${doc.tint})` } as CSSProperties)
                : undefined
            }
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
            {/* On the face too, not only in the popover: a closed project's file. */}
            {closedNoteFor(doc) && (
              <span className="text-muted-foreground ml-1 inline-flex items-center align-middle" title={closedNoteFor(doc) ?? undefined}>
                <Lock className="size-3" aria-hidden />
                <span className="sr-only">{closedNoteFor(doc)}</span>
              </span>
            )}
          </span>
        )
      })}
      {(hidden > 0 || expanded) && documents.length > MAX_ANSWER_SOURCES && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          data-testid="answer-sources-more"
          className="rounded-xs text-muted-foreground duration-quick hover:text-foreground focus-visible:ring-ring/60 cursor-pointer text-xs leading-relaxed underline decoration-dotted underline-offset-2 transition-colors ease-out focus-visible:outline-none focus-visible:ring-2"
        >
          {expanded ? t('answerSources.less') : t('answerSources.more', { count: hidden })}
        </button>
      )}
      {/* Every source of this answer as a citation, in the format the user's
          own tooling reads. Quiet, at the end of the row. */}
      <CopyCitationsMenu citations={refs} />
    </div>
  )
}
