/**
 * SourceCard — one parallel per-document card in the Quellen fan-out
 * (click-dummy `traceSources[]`). Reproduces the dummy's folder-tab-on-card
 * anatomy: a tinted uppercase tab (icon + provenance label) seated on the
 * top-left of a white card holding name · detail · "N Treffer" | gap. The
 * provenance signal drives the tab tint (never hardcoded); the card body is a
 * neutral hairline card so the tab carries the colour.
 */

import type { FC } from 'react'
import { Scale, FileText, Archive, Globe, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sourceSignalStyle } from '@/features/layout/components/SourceSignalChip'
import type { SourceSignal } from '@/features/layout/lib/source-presets'
import { AuthorityTag } from '../AuthorityTag'
import type { TraceSourceCard } from '../../lib/trace-lanes'

/** Provenance icon per signal — mirrors SourceSignalChip so they never drift. */
const SIGNAL_ICON: Record<SourceSignal, LucideIcon> = {
  law: Scale,
  project: FileText,
  office: Archive,
  auto: Globe,
}

export const SourceCard: FC<{ card: TraceSourceCard; hitLabel: string; gapLabel: string }> = ({
  card,
  hitLabel,
  gapLabel,
}) => {
  const hitsText = card.kind === 'gap' ? gapLabel : hitLabel
  const Icon = SIGNAL_ICON[card.signal]
  const tint = sourceSignalStyle(card.signal)

  return (
    <div role="listitem" data-source-card className="flex min-w-0 flex-col">
      {/* Folder tab — tinted, uppercase, seated on the card's top-left. */}
      <span
        className="ml-2.5 inline-flex max-w-[calc(100%-0.625rem)] items-center gap-1 self-start rounded-t-[7px] px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.05em]"
        style={{ backgroundColor: tint.backgroundColor, color: tint.color }}
      >
        <Icon
          className="size-2.5 shrink-0"
          style={{ color: `var(--source-${card.signal})` }}
          aria-hidden="true"
        />
        {card.authority && <AuthorityTag>{card.authority}</AuthorityTag>}
        <span className="truncate">{card.tabLabel}</span>
      </span>

      {/* Card body — neutral hairline card. Gap cards sit back visually
          (dashed hairline, muted ink) so a miss never reads as a hit. */}
      <div
        className={cn(
          'min-w-0 flex-1 rounded-[10px] border bg-card px-3 py-2.5 shadow-xs',
          card.kind === 'gap' && 'border-dashed opacity-75'
        )}
      >
        {/* Two-line clamp instead of a hard truncate — OIB filenames are long
            and the second line usually carries the distinguishing part; the
            full name stays on the title tooltip. */}
        <div
          className="line-clamp-2 text-[12px] font-semibold leading-snug text-foreground"
          title={card.fileName && card.fileName !== card.name ? `${card.name}\n${card.fileName}` : card.name}
        >
          {card.name}
        </div>
        {card.detail && (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={card.detail}>
            {card.detail}
          </div>
        )}
        <div className="mt-1.5">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium',
              card.kind === 'gap'
                ? 'bg-muted text-muted-foreground'
                : 'bg-secondary tabular-nums text-muted-foreground'
            )}
          >
            {hitsText}
          </span>
        </div>
      </div>
    </div>
  )
}
