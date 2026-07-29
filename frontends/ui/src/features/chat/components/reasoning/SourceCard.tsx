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
 *  - "gelesen, nicht verwendet" when retrieval returned it and the answer
 *    did not use it — a real research outcome that was previously not
 *    expressible at all.
 *
 * Shape is unchanged: a tinted uppercase folder tab (icon + provenance label)
 * seated on the top-left of a card holding name · detail · "N Treffer".
 */

import type { FC } from 'react'
import { Scale, FileText, Archive, Globe, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { sourceSignalStyle } from '@/features/layout/components/SourceSignalChip'
import type { SourceSignal } from '@/features/layout/lib/source-presets'
import { AuthorityTag } from '../AuthorityTag'
import { KIND_TO_SIGNAL } from '../../lib/source-kinds'
import {
  citationNumbers,
  citedPages,
  documentTabLabel,
  isCited,
  type CitedDocument,
} from '../../lib/citations'
import { SourcePreviewChip } from '../SourcePreview'

/** Provenance icon per signal — mirrors SourceSignalChip so they never drift. */
const SIGNAL_ICON: Record<SourceSignal, LucideIcon> = {
  law: Scale,
  project: FileText,
  office: Archive,
  auto: Globe,
}

export const SourceCard: FC<{
  document: CitedDocument
  hitLabel: string
  gapLabel: string
}> = ({ document: doc, hitLabel, gapLabel }) => {
  const t = useTranslations('chat')
  const tabLabel = documentTabLabel(doc)
  // Icon keys off the coarse SIGNAL (all Baurecht shares the scales glyph); the
  // tint keys off the fine ACCENT so OIB and RIS are distinguishable at a
  // glance instead of relying on the badge text alone.
  const Icon = SIGNAL_ICON[KIND_TO_SIGNAL[doc.kind]]
  const tint = sourceSignalStyle(doc.tint)
  const used = isCited(doc)
  const numbers = citationNumbers(doc)
  const pages = citedPages(doc)
  const hitsText = doc.loci.length > 0 ? hitLabel : gapLabel
  // The badge earns its space only when it names a tier the label does not
  // already say: "OIB · OIB-Richtlinie" repeated itself and pushed the label
  // into an ellipsis, while "RIS · Bundesrecht" names the register behind it.
  const showAuthority =
    !!doc.authority && !tabLabel.toLowerCase().startsWith(doc.authority.toLowerCase())

  return (
    <div role="listitem" data-source-card className="flex min-w-0 flex-col">
      {/* Folder tab — tinted, uppercase, seated on the card's top-left. */}
      <span
        className="ml-2.5 inline-flex max-w-[calc(100%-0.625rem)] items-center gap-1 self-start rounded-t-[7px] px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.05em]"
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
      </span>

      {/* Card body — neutral hairline card. A document that was read but never
          cited sits back visually (dashed hairline, muted ink) so it never
          reads as grounding the answer did not actually use. */}
      <div
        className={cn(
          'min-w-0 flex-1 rounded-[10px] border bg-card px-3 py-2.5 shadow-xs',
          !used && 'border-dashed opacity-75'
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
          className="border-0 bg-transparent p-0 shadow-none hover:bg-transparent"
        />

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium',
              used ? 'bg-secondary tabular-nums text-muted-foreground' : 'bg-muted text-muted-foreground'
            )}
          >
            {hitsText}
          </span>
          {pages.length > 0 && (
            <span className="text-[10.5px] tabular-nums text-muted-foreground">
              {t('answerSources.pages', { pages: pages.join(', ') })}
            </span>
          )}
          {/* Which markers in the answer this document carries — the link
              between "what was read" and "what was used" that the trace could
              not express before. A document the answer used but whose [N] the
              backend never resolved shows neither: claiming "not used" there
              would be a statement about the ANSWER made from a missing number. */}
          {numbers.length > 0 && (
            <span className="text-[10.5px] font-semibold tabular-nums text-muted-foreground">
              {numbers.map((n) => `[${n}]`).join(' ')}
            </span>
          )}
          {!used && (
            <span className="text-[10.5px] italic text-muted-foreground/80">
              {t('thinking.readNotUsed')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
