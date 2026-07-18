/**
 * SourceCard — one parallel per-document card in the Quellen fan-out
 * (click-dummy `traceSources[]`). Ported verbatim from the previous inline
 * ChatThinking implementation: tab · name · detail · "N Treffer" | gap, with
 * the provenance signal driving the tint + a subtle left signal rail.
 */

import type { FC } from 'react'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import { AuthorityTag } from '../AuthorityTag'
import type { TraceSourceCard } from '../../lib/trace-lanes'

export const SourceCard: FC<{ card: TraceSourceCard; hitLabel: string; gapLabel: string }> = ({
  card,
  hitLabel,
  gapLabel,
}) => {
  const hitsText = card.kind === 'gap' ? gapLabel : hitLabel
  return (
    <div
      role="listitem"
      className="flex flex-col gap-1.5 rounded-xl border bg-background/70 px-3 py-2.5 shadow-xs"
      style={{
        borderColor: `color-mix(in oklch, var(--source-${card.signal}, var(--border)) 40%, transparent)`,
        boxShadow: `inset 3px 0 0 0 var(--source-${card.signal}, var(--border))`,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <SourceSignalChip signal={card.signal}>
          {card.authority && <AuthorityTag>{card.authority}</AuthorityTag>}
          {card.tabLabel}
        </SourceSignalChip>
        <span
          className={
            card.kind === 'gap'
              ? 'shrink-0 text-[11px] font-medium text-muted-foreground'
              : 'shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground'
          }
        >
          {hitsText}
        </span>
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-foreground" title={card.name}>
          {card.name}
        </div>
        {card.detail && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground" title={card.detail}>
            {card.detail}
          </div>
        )}
      </div>
    </div>
  )
}
