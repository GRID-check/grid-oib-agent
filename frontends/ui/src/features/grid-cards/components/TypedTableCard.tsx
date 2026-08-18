/**
 * TypedTableCard — a generic table where the agent declares each COLUMN's type,
 * so the frontend renders each cell right instead of as flat text.
 *
 * One card for the long tail of tabular answers: `mass`/`date` columns are
 * right-aligned with tabular-nums so figures line up, a `verdict` cell renders
 * as a status chip (its German word mapped to the shared pass/fail palette, with
 * the word always shown so colour never travels alone), and a `norm` cell is
 * emphasised. The table scrolls horizontally inside the card so the chat column
 * never scrolls sideways.
 */

import { type FC } from 'react'
import { Table2 } from 'lucide-react'
import { SchematicCard, statusColor, statusLabel } from '../schematics/kit'
import { cn } from '@/lib/utils'
import type { DimStatus, NormReferenceData, TypedColumnData, TypedColumnKind } from '../schematics/types'

interface TypedTableCardProps {
  title: string
  columns: TypedColumnData[]
  rows: string[][]
  reference?: NormReferenceData | null
  note?: string | null
}

/** `mass` and `date` are numeric-ish and read right-aligned with tabular-nums. */
const isNumeric = (kind: TypedColumnKind): boolean => kind === 'mass' || kind === 'date'

/**
 * Map a German verdict cell to a shared check status, so a `verdict` column
 * renders with the same palette as every other card. An unrecognised word gets
 * no status and renders as a neutral chip — the card never guesses a verdict.
 */
const verdictStatus = (value: string): DimStatus | null => {
  const v = value.trim().toLowerCase()
  if (['erfüllt', 'ja', 'zulässig', 'ok', 'bestanden'].includes(v)) return 'pass'
  if (['nicht erfüllt', 'nein', 'unzulässig', 'nicht zulässig'].includes(v)) return 'fail'
  if (['grenzwertig', 'bedingt', 'bedingt erfüllt'].includes(v)) return 'warning'
  if (['offen', 'unklar', 'zu prüfen', 'angabe fehlt', 'fehlt'].includes(v)) return 'needs_input'
  return null
}

const VerdictCell: FC<{ value: string }> = ({ value }) => {
  if (!value) return <span className="text-muted-foreground">—</span>
  const status = verdictStatus(value)
  if (!status) {
    return (
      <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        {value}
      </span>
    )
  }
  const color = statusColor(status)
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color, backgroundColor: `color-mix(in oklch, ${color} 14%, transparent)` }}
      aria-label={statusLabel(status)}
    >
      {value}
    </span>
  )
}

const Cell: FC<{ kind: TypedColumnKind; value: string }> = ({ kind, value }) => {
  if (kind === 'verdict') return <VerdictCell value={value} />
  if (!value) return <span className="text-muted-foreground">—</span>
  if (kind === 'norm') return <span className="font-medium text-foreground">{value}</span>
  if (isNumeric(kind)) return <span className="tabular-nums text-foreground">{value}</span>
  return <span className="text-foreground">{value}</span>
}

export const TypedTableCard: FC<TypedTableCardProps> = ({ title, columns, rows, reference, note }) => {
  return (
    <SchematicCard icon={Table2} eyebrow="Tabelle" title={title} note={note} reference={reference}>
      <div className="w-full overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-xs">
          <thead>
            <tr className="border-b">
              {columns.map((column, ci) => (
                <th
                  key={`col-${ci}`}
                  scope="col"
                  className={cn(
                    'whitespace-nowrap px-3 py-1.5 font-normal text-muted-foreground first:pl-0',
                    isNumeric(column.type) ? 'text-right' : 'text-left',
                  )}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((row, ri) => (
              <tr key={`row-${ri}`}>
                {columns.map((column, ci) => (
                  <td
                    key={`cell-${ri}-${ci}`}
                    className={cn(
                      'px-3 py-2 align-top first:pl-0',
                      isNumeric(column.type) ? 'whitespace-nowrap text-right' : 'text-left',
                    )}
                  >
                    <Cell kind={column.type} value={row[ci] ?? ''} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SchematicCard>
  )
}
