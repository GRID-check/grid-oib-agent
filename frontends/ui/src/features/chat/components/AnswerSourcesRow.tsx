/**
 * AnswerSourcesRow — "Belegt durch" provenance chip row under an answer.
 *
 * Renders ONLY source data that already exists on the message (citations from
 * the deep-research path, legal_basis cards on shallow answers) — no fake
 * chips (WS-3 item 4). Origins map onto the spec §4 provenance signals:
 * color family: Baurecht (OIB corpus + RIS), Büroarchiv, Projektwissen, Web —
 * derived from the canonical wire `kind` (ADR-0026), with an OIB/RIS/ÖNORM
 * authority badge on top. Each chip carries icon + label + color together
 * (color is never the only carrier).
 *
 * WS-9: chips are interactive — Web/RIS chips link out, KB chips open a
 * source preview (document dialog or info popover) via SourcePreviewChip.
 */

'use client'

import { type FC } from 'react'
import { Globe } from 'lucide-react'
import { useTranslations } from '@/i18n'
import type { GridCard } from '@/shared/cards/schemas'
import { deriveAnswerSources } from '../lib/answer-sources'
import type { CitationSource } from '../types'
import { SourcePreviewChip } from './SourcePreview'

interface AnswerSourcesRowProps {
  citations?: CitationSource[]
  cards?: GridCard[]
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
  routingDecision,
  isStreaming = false,
}) => {
  const t = useTranslations('chat')
  const sources = deriveAnswerSources(citations, cards)

  if (sources.length === 0) {
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

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-t pt-2"
      role="list"
      aria-label={t('answerSources.ariaLabel')}
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {t('answerSources.label')}
      </span>
      {sources.map((source) => (
        <span role="listitem" key={source.key} className="inline-flex max-w-full">
          <SourcePreviewChip source={source} signal={source.signal} />
        </span>
      ))}
    </div>
  )
}
