/**
 * AnswerSourcesRow — the answer's single "Belegt durch" provenance block.
 *
 * Renders ONLY source data that already exists on the message (citations from
 * the deep-research path, legal_basis cards on shallow answers, and the answer's
 * own written sources section) — no fake chips (WS-3 item 4). Origins map onto
 * the spec §4 provenance signals: color family: Baurecht (OIB corpus + RIS),
 * Büroarchiv, Projektwissen, Web — derived from the canonical wire `kind`
 * (ADR-0026), with an OIB/RIS/ÖNORM authority badge on top. Each chip carries
 * icon + label + color together (color is never the only carrier).
 *
 * WS-9: chips are interactive — Web/RIS chips link out, KB chips open a
 * source preview (document dialog or info popover) via SourcePreviewChip.
 *
 * Two shapes, one component:
 *  - NUMBERED LIST, whenever the answer numbers its sources (`[N]` markers).
 *    This is the consolidation: the numbers, full titles and page/host locators
 *    that used to sit in a separate written "Quellen" list below the answer are
 *    merged INTO the chips, so the answer states its sources once. Each row is
 *    an anchor target, so an inline `[N]` in the prose scrolls to its source.
 *  - COMPACT WRAP ROW, when there are no numbers (nothing per-source to line up)
 *    — the original chip row, unchanged.
 */

'use client'

import { type FC } from 'react'
import { Globe } from 'lucide-react'
import { useTranslations } from '@/i18n'
import type { GridCard } from '@/shared/cards/schemas'
import type { ReportSourceEntry } from '@/features/layout/lib/report-citations'
import { answerSourceItems } from '../lib/answer-source-list'
import type { CitationSource } from '../types'
import { SourcePreviewChip } from './SourcePreview'
import { CopyCitationsMenu, CopySourceCitationButton } from './CopyCitation'

interface AnswerSourcesRowProps {
  citations?: CitationSource[]
  cards?: GridCard[]
  /**
   * The written source entries lifted out of the answer markdown (AgentResponse
   * splits them off so they are not rendered twice). Merged into the chips here.
   */
  sourceEntries?: ReportSourceEntry[]
  /** DOM id prefix for the numbered rows — per message, so anchors stay unique. */
  anchorPrefix?: string
  /**
   * The turn's routing (WP-A). A substantive `shallow`/`deep` (or absent/legacy)
   * answer with zero sources gets the honest "Lücke" gap row; a `meta`/`error`
   * turn (conversational reply, error) does not — it makes no source claim.
   */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  /** While the answer is still streaming, sources arrive late — suppress the gap row. */
  isStreaming?: boolean
}


export const AnswerSourcesRow: FC<AnswerSourcesRowProps> = ({
  citations,
  cards,
  sourceEntries,
  anchorPrefix,
  routingDecision,
  isStreaming = false,
}) => {
  const t = useTranslations('chat')
  const items = answerSourceItems(sourceEntries, citations, cards)

  if (items.length === 0) {
    // Honest "Lücke" treatment (design language §Domain-specific): a substantive
    // answer that cites nothing must say so in the neutral `--source-auto` gray
    // family (globe/gap icon + label), never hide its lack of grounding. Skipped
    // for meta/error turns (no source claim) and while still streaming.
    const isSubstantive = routingDecision !== 'meta' && routingDecision !== 'error'
    if (!isSubstantive || isStreaming) return null

    return (
      <div
        className="flex flex-wrap items-center gap-1.5 border-t pt-2"
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

  const label = (
    <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
      {t('answerSources.label')}
    </span>
  )

  // No numbers anywhere → nothing to line up; keep the compact chip row.
  if (!items.some((item) => item.number != null)) {
    return (
      <div
        className="flex flex-wrap items-center gap-1.5 border-t pt-2"
        role="list"
        aria-label={t('answerSources.ariaLabel')}
      >
        {label}
        {items.map((item) => (
          <span role="listitem" key={item.key} className="inline-flex max-w-full">
            <SourcePreviewChip source={item.ref} signal={item.ref.signal} />
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className="border-t pt-2">
      <div className="flex items-center justify-between gap-2">
        {label}
        {/* The block's real payoff: every source as a citation the user can
            paste into a Befund, Word or their reference manager. */}
        <CopyCitationsMenu items={items} />
      </div>
      <ol className="mt-1 list-none space-y-0.5 pl-0" aria-label={t('answerSources.ariaLabel')}>
        {items.map((item) => (
          <li
            key={item.key}
            id={item.number != null && anchorPrefix ? `${anchorPrefix}${item.number}` : undefined}
            className="group flex scroll-mt-4 items-center gap-1"
          >
            <span
              className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground"
              aria-hidden={item.number == null}
            >
              {item.number != null ? item.number : ''}
            </span>
            <SourcePreviewChip
              source={item.ref}
              signal={item.ref.signal}
              variant="row"
              meta={
                item.page != null ? t('answerSources.page', { page: item.page }) : item.host
              }
            />
            <CopySourceCitationButton item={item} />
          </li>
        ))}
      </ol>
    </div>
  )
}
