/**
 * RequirementChecklistCard — the "Voraussetzungen" checklist of the click-dummy
 * Ergebnis card: an uppercase section label over check-circle rows, each with
 * the requirement text and — where given — its own provenance citation chip.
 *
 * Rendered flat (no card chrome) so it sits directly inside the result block.
 * The per-row status icon carries the verdict (colour + shape + aria-label);
 * a fail/warning/needs_input row also shows its German verdict inline so the
 * signal never travels by colour alone.
 *
 * A `needs_input` row additionally carries an {@link AskAboutChip}: the row
 * already says which requirement is open and what is missing about it, and
 * making the reader retype that into the composer is what kept the question
 * from being asked at all. The chip only queues a draft — nothing is sent,
 * fetched or decided by it — so this stays `presentational`.
 */

import { type FC } from 'react'
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { SectionLabel } from '@/components/ui/section-label'
import { AskAboutChip } from './AskAboutChip'
import { statusColor, statusLabel } from '../schematics/kit'
import type { ChecklistItemData, DimStatus, NormReferenceData } from '../schematics/types'

interface RequirementChecklistCardProps {
  title: string
  items: ChecklistItemData[]
  reference?: NormReferenceData | null
  note?: string | null
}

const STATUS_ICON: Record<DimStatus, LucideIcon> = {
  pass: CircleCheck,
  fail: CircleX,
  warning: TriangleAlert,
  needs_input: CircleHelp,
}

/** "OIB-Richtlinie 2 · Pkt. 3.1" — compact inline citation for one item. */
const shortRef = (ref: NormReferenceData): string =>
  ref.section ? `${ref.document} · ${ref.section}` : ref.document

export const RequirementChecklistCard: FC<RequirementChecklistCardProps> = ({
  title,
  items,
  reference,
  note,
}) => {
  const sameAsFooter = (ref: NormReferenceData): boolean =>
    reference != null && ref.document === reference.document && ref.section === reference.section

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex flex-col">
      {/* Section label — the shared eyebrow primitive, not a hand-rolled copy.
          `tracking-[0.05em]` was exactly `tracking-wider` and the weight was a
          step heavy (the ramp says `font-medium`); SectionLabel carries both. */}
      <SectionLabel as="div">{title}</SectionLabel>

      <div className="mt-[9px] flex flex-col gap-[9px]">
        {items.map((item, index) => {
          // `?? CircleHelp`, because the nested card fields are `z.any()` in
          // the generated schema: a status this build does not know reaches
          // here as a string, `Icon` is `undefined`, and rendering it throws
          // — taking the whole conversation with it, since nothing wraps
          // `GridCards` in an error boundary.
          const Icon = STATUS_ICON[item.status] ?? CircleHelp
          const color = statusColor(item.status)
          // The dummy checklist reference chip resolves against a per-item
          // reference, else the card's footer reference.
          const itemRef = item.reference ?? reference ?? null
          const showRef = itemRef != null && (item.reference == null || !sameAsFooter(item.reference))
          return (
            <div key={`${item.label}-${index}`} className="flex items-start gap-2.5">
              <Icon
                className="mt-[3px] size-3.5 shrink-0"
                style={{ color }}
                aria-label={statusLabel(item.status)}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13.5px] leading-[1.6] text-default">{item.label}</span>
                {item.detail && (
                  <p className="text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
                )}
                {/* Verdict inline for non-pass rows (colour never travels alone).
                    A row that cannot be decided also offers the question it
                    implies: the row already names the requirement and what is
                    open about it, so the reader should not have to retype
                    either — one click puts the whole sentence in the composer,
                    where they still edit it and press send. */}
                {item.status !== 'pass' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-medium" style={{ color }}>
                      {statusLabel(item.status)}
                    </span>
                    {item.status === 'needs_input' && (
                      <AskAboutChip subject={item.label} missing={item.detail} />
                    )}
                  </div>
                )}
              </div>
              {showRef && itemRef && (
                <span className="shrink-0 whitespace-nowrap rounded-md bg-source-law-tint px-2 py-[3px] text-[11px] text-source-law-text">
                  {shortRef(itemRef)}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {note && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{note}</p>}
    </div>
  )
}
