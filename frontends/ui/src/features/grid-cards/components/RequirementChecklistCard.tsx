/**
 * RequirementChecklistCard — several pass/fail criteria for one question
 * ("Was muss ich für GK 4 erfüllen?"), each with its own verdict and, where
 * given, its own norm reference.
 *
 * Reuses the schematic chrome (eyebrow, verdict pill, norm footer) so the
 * card reads as part of the same family: one row per requirement with the
 * status icon + German verdict, an optional detail line, and a per-item
 * reference shown inline when it differs from the card's footer reference.
 */

import { type FC } from 'react'
import { ListChecks } from 'lucide-react'
import {
  SchematicCard,
  statusColor,
  statusLabel,
  worstStatus,
} from '../schematics/kit'
import { CircleCheck, CircleHelp, CircleX, TriangleAlert, type LucideIcon } from 'lucide-react'
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
    <SchematicCard
      icon={ListChecks}
      eyebrow="Checkliste"
      title={title}
      verdict={worstStatus(items.map((i) => i.status))}
      note={note}
      reference={reference}
    >
      <ul className="flex flex-col divide-y divide-border/60">
        {items.map((item, index) => {
          const Icon = STATUS_ICON[item.status]
          const color = statusColor(item.status)
          return (
            <li key={`${item.label}-${index}`} className="flex gap-2.5 py-2 first:pt-0 last:pb-0">
              <Icon
                className="mt-0.5 size-4 shrink-0"
                style={{ color }}
                aria-label={statusLabel(item.status)}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-foreground">{item.label}</span>
                  <span className="shrink-0 text-xs font-medium" style={{ color }}>
                    {statusLabel(item.status)}
                  </span>
                </div>
                {item.detail && (
                  <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
                    {item.detail}
                  </p>
                )}
                {item.reference && !sameAsFooter(item.reference) && (
                  <p className="text-[11px] text-muted-foreground">{shortRef(item.reference)}</p>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </SchematicCard>
  )
}
