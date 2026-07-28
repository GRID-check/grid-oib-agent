/**
 * CitationCard — one source in the research panel's source list.
 *
 * This is the SAME citation the answer's "Belegt durch" row renders, in a
 * roomier layout. It therefore renders through the same component
 * (`SourcePreviewChip`, `variant="card"`), which means one provenance tint, one
 * authority badge, one target resolution and one click behaviour:
 *
 *  - a web / RIS source links out,
 *  - a document opens the PDF viewer at the cited page,
 *  - anything unresolvable opens the info popover.
 *
 * It used to be an independent renderer that showed none of that: a
 * knowledge-base citation here carried no tint, no badge, no page and — because
 * its only interaction was an `<a href>` and a KB citation has no URL — was
 * literally inert, while the identical source one tab over opened a PDF at the
 * cited page with a bindingness popover.
 *
 * SSE Events:
 * - artifact.update type: "citation_source" - Referenced (discovered during search)
 * - artifact.update type: "citation_use" - Cited (actually used in report)
 */

'use client'

import { type FC, useMemo } from 'react'
import { Check } from 'lucide-react'
import { useLocale, useTranslations } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import { SourcePreviewChip } from '@/features/chat/components/SourcePreview'
import { deriveAnswerSources } from '@/features/chat/lib/answer-sources'
import type { CitationSource } from '@/features/chat/types'

interface CitationCardProps {
  /** Citation information */
  citation: CitationSource
  /** 1-based position in the citation list, rendered as a numbered marker. */
  index?: number
}

/**
 * One citation as a full-width list row: provenance-tinted, badged, and
 * clickable exactly like its chip counterpart.
 */
export const CitationCard: FC<CitationCardProps> = ({ citation, index }) => {
  const { locale } = useLocale()
  const t = useTranslations('chat')

  // Same derivation the answer's provenance row uses, so the tint, the label
  // and the authority badge cannot disagree between the two surfaces.
  const ref = useMemo(() => deriveAnswerSources([citation])[0], [citation])

  if (!ref) return null

  // This list is ordered by recency and numbers its rows by POSITION, which is
  // what the panel has always shown. That is deliberately not the answer's [N]
  // (the two disagree, and the panel has no prose for an [N] to point at), so
  // the list position wins whenever the caller supplies one.
  const source = { ...ref, number: index ?? ref.number }

  return (
    <div className="animate-in fade-in-0">
      <SourcePreviewChip
        source={source}
        signal={ref.signal}
        variant="card"
        trailing={
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            {citation.isCited && (
              <span className="inline-flex items-center gap-1 text-success">
                <Check className="size-3" aria-hidden="true" />
                {t('sourcePreview.cited')}
              </span>
            )}
            <span>{formatTime(citation.timestamp, locale)}</span>
          </span>
        }
      />
    </div>
  )
}
