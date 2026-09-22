/**
 * SourceCard — one document in the Herleitung's source fan-out.
 *
 * It renders a {@link CitedDocument}, which is the same object the answer's
 * "Belegt durch" chips render. That is the point: this card and that chip used
 * to be built from two disconnected pipelines (the `## Trace-Lanes` JSON here,
 * the structured citation wire there) with no shared identity, so the trace
 * could show what was searched but never say which document became `[3]`, and
 * the two could disagree about a document's name and colour without anything
 * noticing.
 *
 * Now the card can state both halves of the derivation honestly:
 *  - the markers it carries in the answer (`[2] [7]`), or
 *  - "abgerufen, nicht zitiert" when retrieval returned it and the answer
 *    did not use it — a real research outcome that was previously not
 *    expressible at all.
 *
 * Shape is unchanged: a tinted uppercase folder tab (icon + provenance label)
 * seated on the top-left of a card holding name · detail · "N Treffer".
 */

import { Fragment, type FC } from 'react'
import { Scale, FileText, Archive, Globe, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { sourceSignalStyle } from '@/features/layout/components/SourceSignalChip'
import type { SourceSignal } from '@/features/layout/lib/source-presets'
import { SectionLabel } from '@/components/ui/section-label'
import { AuthorityTag } from '../AuthorityTag'
import { KIND_TO_SIGNAL } from '../../lib/source-kinds'
import {
  citationNumbers,
  documentPages,
  documentTabLabel,
  isCited,
  type CitedDocument,
} from '../../lib/citations'
import type { RoundLocus } from '../../lib/retrieval-rounds'
import { Ruler } from 'lucide-react'
import { SourcePreviewChip } from '../SourcePreview'

/** Provenance icon per signal — mirrors SourceSignalChip so they never drift. */
const SIGNAL_ICON: Record<SourceSignal, LucideIcon> = {
  law: Scale,
  project: FileText,
  office: Archive,
  auto: Globe,
  // Ruler, matching SourceSignalChip: the measurement lane is the one source
  // that was MEASURED rather than retrieved, and the comment above promises
  // these two never drift.
  model: Ruler,
}

/**
 * The pages and Punkte one round read of one document, in the order the round
 * returned them, printed exactly as the backend stated them (`p.12`,
 * `Pkt. 3.1` — rendered, never parsed).
 *
 * `marked` is off when EVERY locus was a re-fetch: the pill above already says
 * so once, and repeating it beside each line would bury the one thing the
 * reader came for. It is on for a mixed round, where the distinction between
 * "read three more Punkte" and "read them all again" lives per locus.
 */
const RoundLoci: FC<{ loci: RoundLocus[]; marked: boolean; repeatLabel: string }> = ({
  loci,
  marked,
  repeatLabel,
}) => {
  const named = loci.filter((locus) => locus.detail)
  if (named.length === 0) return null
  return (
    <span className="text-muted-foreground text-xs tabular-nums">
      {named.map((locus, i) => (
        // A Fragment, not a wrapper span: the separators and the loci stay
        // direct text of one element, so the line reads as one string to a
        // screen reader and to a test rather than as a row of chips.
        <Fragment key={`${locus.detail}-${i}`}>
          {i > 0 && ', '}
          {locus.detail}
          {marked && locus.repeat && (
            <span className="text-muted-foreground/80 italic"> ({repeatLabel})</span>
          )}
        </Fragment>
      ))}
    </span>
  )
}

export const SourceCard: FC<{
  document: CitedDocument
  hitLabel: string
  gapLabel: string
  /** The turn is still running — see the `live` note on the verdict below. */
  live?: boolean
  /**
   * Every passage THIS round read of the document, when a ledger round built
   * the fan.
   *
   * The card is the same card — same chip, same preview, same markers — but a
   * fan slot under a round is a claim about that round, so the locus line
   * states the round's own pages/Punkte, in its own order, and a passage the
   * round fetched a second time says so instead of repeating the turn's hit
   * count. Absent on the turn-level fan, where the aggregate IS the claim.
   */
  loci?: RoundLocus[]
}> = ({ document: doc, hitLabel, gapLabel, live = false, loci }) => {
  const t = useTranslations('chat')
  // The tab states the document's provenance: its fine lane, else the SHELF the
  // wire carried (ADR-0047 — read as data, never prefix-matched off a collection
  // id), else the coarse display stratum. A document with no shelf on the wire
  // is simply not attributed to one; it never inherits a guessed shelf.
  const tabLabel = documentTabLabel(doc, t)
  // Icon keys off the coarse SIGNAL (all Baurecht shares the scales glyph); the
  // tint keys off the fine ACCENT so OIB and RIS are distinguishable at a
  // glance instead of relying on the badge text alone.
  const Icon = SIGNAL_ICON[KIND_TO_SIGNAL[doc.kind]]
  const tint = sourceSignalStyle(doc.tint)
  const used = isCited(doc)
  const numbers = citationNumbers(doc)
  // `documentPages`, not `citedPages`: this card also stands for a document
  // labelled „abgerufen, nicht zitiert", every locus of which is uncited, and
  // the precise claim is empty for exactly those — silently deleting the pages
  // retrieval actually read from the one surface whose job is to show them.
  const pages = documentPages(doc)
  const hitsText = doc.loci.length > 0 ? hitLabel : gapLabel
  // Every passage this round read was one it had already fetched, so the round
  // did no new work on this document and one pill says it once. A round that
  // reached even one new passage keeps its tally and marks the repeats where
  // they happened — see {@link RoundLoci}.
  const allRepeat = !!loci && loci.length > 0 && loci.every((locus) => locus.repeat)
  // The badge earns its space only when it names a tier the label does not
  // already say: "OIB · OIB-Richtlinie" repeated itself and pushed the label
  // into an ellipsis, while "RIS · Bundesrecht" names the register behind it.
  const showAuthority =
    !!doc.authority && !tabLabel.toLowerCase().startsWith(doc.authority.toLowerCase())

  return (
    <div role="listitem" data-source-card className="flex min-w-0 flex-col">
      {/* Folder tab — tinted, uppercase, seated on the card's top-left. */}
      <SectionLabel
        className="ml-2.5 inline-flex max-w-[calc(100%-0.625rem)] items-center gap-1 self-start rounded-t-md px-2 py-1"
        style={{ backgroundColor: tint.backgroundColor, color: tint.color }}
      >
        {/* The glyph is dropped when a badge is shown: at column width the tab
            fits roughly one of icon / badge / full label, and "RIS" carries the
            provenance in TEXT — which satisfies the same a11y rule the icon
            exists for (colour is never the only carrier) while leaving the lane
            label room to render as "BUNDESRECHT" instead of "BUNDESREC…". */}
        {!showAuthority && (
          <Icon
            className="size-2.5 shrink-0"
            style={{ color: `var(--source-${doc.tint})` }}
            aria-hidden="true"
          />
        )}
        {showAuthority && <AuthorityTag>{doc.authority}</AuthorityTag>}
        <span className="truncate">{tabLabel}</span>
      </SectionLabel>

      {/* Card body — neutral hairline card. A document that was read but never
          cited sits back visually (dashed hairline, muted ink) so it never
          reads as grounding the answer did not actually use. */}
      <div
        className={cn(
          'bg-card shadow-xs min-w-0 flex-1 rounded-lg border px-3 py-2.5',
          // Only set a document back once the verdict is real. While the turn
          // streams nothing has been cited yet, so dimming would grey out every
          // source the answer is about to lean on.
          !used && !live && 'border-dashed opacity-75'
        )}
      >
        {/* The card IS the citation — clicking it opens the document at the
            page the answer used, exactly as the chip under the answer does.
            It used to be inert markup, which made the surface that claims to
            prove the derivation the one place a source could not be checked. */}
        <SourcePreviewChip
          citation={{ document: doc }}
          variant="card"
          // The folder tab above already carries the icon, the badge and the
          // lane, and the meta line below carries the markers and pages — so
          // the card itself needs only the NAME. Printing the full chrome here
          // squeezed the one thing this card exists to say into an ellipsis.
          detail="name-only"
          // `p-0` is what strips the row down to the name — and it strips the
          // TARGET down with it: the card's own `py-2.5` stays on the card, so
          // the only thing a finger could press to open the source was the 19px
          // line box of the title. On a phone that is the primary action of the
          // whole Herleitung, sized like a mouse's.
          //
          // The height is bought back out of padding the card already spends
          // rather than added to it: `min-h-11` reaches the 44px floor and
          // `-my-2` pulls 8px of it back through the card's own inset, so the
          // card grows ~9px instead of ~25px and the fan-out keeps its density.
          // `items-center` because a flex row defaults to `stretch`, which would
          // pin the title to the top of the taller box and leave the extra
          // height looking like a gap rather than part of the control.
          className="pointer-coarse:-my-2 pointer-coarse:min-h-11 pointer-coarse:items-center border-0 bg-transparent p-0 shadow-none hover:bg-transparent"
        />

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {/* A round that only re-fetched what it already had states THAT,
              muted, where the count would be: the turn aggregate ("4 Treffer")
              is identical on every repeat of the same file, which is exactly
              what made a re-read indistinguishable from a new fetch. */}
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              allRepeat
                ? 'bg-muted text-muted-foreground/80 italic'
                : used
                  ? 'bg-secondary text-muted-foreground tabular-nums'
                  : 'bg-muted text-muted-foreground'
            )}
          >
            {allRepeat ? t('thinking.node.roundDocRepeat') : hitsText}
          </span>
          {/* The loci. Under a ledger round they are THAT round's pages and
              Punkte, as the backend stated them — and nothing at all when the
              round named none, because the turn aggregate would be a claim
              about other rounds. Everywhere else it stays the aggregate it
              always was. */}
          {loci ? (
            <RoundLoci
              loci={loci}
              marked={!allRepeat}
              repeatLabel={t('thinking.node.roundDocRepeat')}
            />
          ) : (
            pages.length > 0 && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {/* Singular and plural are two keys, as every other page line in
                      the product already knows. German „S." is number-agnostic, so
                      always taking the plural was invisible here and read „pp. 9"
                      in English. */}
                {pages.length === 1
                  ? t('answerSources.page', { page: pages[0]! })
                  : t('answerSources.pages', { pages: pages.join(', ') })}
              </span>
            )
          )}
          {/* Which markers in the answer this document carries — the link
              between "what was read" and "what was used" that the trace could
              not express before. A document the answer used but whose [N] the
              backend never resolved shows neither: claiming "not used" there
              would be a statement about the ANSWER made from a missing number. */}
          {numbers.length > 0 && (
            <span className="text-muted-foreground text-xs font-semibold tabular-nums">
              {numbers.map((n) => `[${n}]`).join(' ')}
            </span>
          )}
          {/* "abgerufen, nicht zitiert" is a claim about the FINISHED answer.
              While the turn is still running there is no answer to make it
              about, so every retrieved document read as discarded — including
              the ones about to be cited a second later. Withheld until the
              turn lands. */}
          {!used && !live && (
            <span className="text-muted-foreground/80 text-xs italic">
              {t('thinking.readNotUsed')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A ledger doc the turn's card model has no card for.
 *
 * The answer-repair pass reads files after the cards are built, and a name the
 * model dropped is a name the fan would otherwise silently lose — so the slot
 * survives as what the ledger actually knows: the name and the loci THAT round
 * read, with the same repeat verdict a carded slot draws. Deliberately bare
 * otherwise: no chip, no preview, no citation markers. Every one of those would
 * be a claim about a document this turn has no card for, and a control that
 * opens nothing is worse than no control.
 */
export const BareSourceCard: FC<{ name: string; loci?: RoundLocus[] }> = ({ name, loci }) => {
  const t = useTranslations('chat')
  // The same verdict the carded slot draws, through the same component — a
  // slot without a card still knows what its round did, and dropping the
  // marker here would make a re-fetch look like a first read on exactly the
  // documents the reader can check least.
  const allRepeat = !!loci && loci.length > 0 && loci.every((locus) => locus.repeat)
  return (
    <div role="listitem" data-source-card className="flex min-w-0 flex-col">
      <div className="bg-card shadow-xs min-w-0 flex-1 rounded-lg border border-dashed px-3 py-2.5 opacity-75">
        <p className="text-foreground line-clamp-2 text-sm leading-snug">{name}</p>
        {loci && loci.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {/* No hit tally to stand in for: a bare slot has no card, so the
                pill appears only when there is a repeat to declare. */}
            {allRepeat && (
              <span className="bg-muted text-muted-foreground/80 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium italic">
                {t('thinking.node.roundDocRepeat')}
              </span>
            )}
            <RoundLoci
              loci={loci}
              marked={!allRepeat}
              repeatLabel={t('thinking.node.roundDocRepeat')}
            />
          </div>
        )}
      </div>
    </div>
  )
}
