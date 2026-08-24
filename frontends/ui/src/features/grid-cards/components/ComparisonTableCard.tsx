/**
 * ComparisonTableCard — a side-by-side comparison of a small number of
 * options (GK 4 vs GK 5, two escape-route variants, …).
 *
 * Options are columns, criteria are rows. A row's favoured option (the
 * model's `highlight_index`) is tinted success and marked; an overall
 * recommendation renders as a line under the table. The table scrolls
 * horizontally inside the card so the chat column never scrolls sideways.
 */

import { type FC } from 'react'
import { Columns3, ThumbsUp } from 'lucide-react'
import { SchematicCard, statusColor } from '../schematics/kit'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { ComparisonRowData, NormReferenceData } from '../schematics/types'

interface ComparisonTableCardProps {
  title: string
  options: string[]
  rows: ComparisonRowData[]
  recommendation?: string | null
  reference?: NormReferenceData | null
  note?: string | null
}

export const ComparisonTableCard: FC<ComparisonTableCardProps> = ({
  title,
  options,
  rows,
  recommendation,
  reference,
  note,
}) => {
  const t = useTranslations('chat')
  const success = statusColor('pass')

  return (
    <SchematicCard
      icon={Columns3}
      eyebrow={t('cards.comparison.eyebrow')}
      title={title}
      note={note}
      reference={reference}
    >
      <div className="w-full overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-xs">
          <thead>
            <tr className="border-b">
              <th className="py-1.5 pr-3 text-left font-normal text-muted-foreground" scope="col">
                {t('cards.comparison.criterion')}
              </th>
              {options.map((option, i) => (
                <th
                  key={`opt-${i}`}
                  className="min-w-24 whitespace-nowrap px-3 py-1.5 text-left font-semibold text-foreground"
                  scope="col"
                >
                  {option}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((row, ri) => (
              <tr key={`row-${ri}`}>
                <th
                  className="max-w-48 py-2 pr-3 text-left font-normal text-muted-foreground"
                  scope="row"
                >
                  {row.label}
                </th>
                {options.map((_, ci) => {
                  const highlighted = row.highlight_index === ci
                  return (
                    <td
                      key={`cell-${ri}-${ci}`}
                      className={cn(
                        'min-w-24 whitespace-nowrap px-3 py-2 align-top text-foreground',
                        highlighted && 'font-medium',
                      )}
                      style={
                        highlighted
                          ? { backgroundColor: `color-mix(in oklch, ${success} 10%, transparent)` }
                          : undefined
                      }
                    >
                      {row.values[ci] || <span className="text-muted-foreground">—</span>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {recommendation && (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-foreground">
          <ThumbsUp className="mt-0.5 size-3.5 shrink-0" style={{ color: success }} aria-hidden="true" />
          <span className="max-w-prose">{recommendation}</span>
        </p>
      )}
    </SchematicCard>
  )
}
