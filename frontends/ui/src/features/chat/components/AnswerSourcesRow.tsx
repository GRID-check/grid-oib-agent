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
import { useTranslations } from '@/i18n'
import type { GridCard } from '@/shared/cards/schemas'
import { deriveAnswerSources } from '../lib/answer-sources'
import type { CitationSource } from '../types'
import { SourcePreviewChip } from './SourcePreview'

interface AnswerSourcesRowProps {
  citations?: CitationSource[]
  cards?: GridCard[]
}

export const AnswerSourcesRow: FC<AnswerSourcesRowProps> = ({ citations, cards }) => {
  const t = useTranslations('chat')
  const sources = deriveAnswerSources(citations, cards)

  if (sources.length === 0) return null

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
