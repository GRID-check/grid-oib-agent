/**
 * ConditionTreeCard — a Bedingungsbaum for the domain's most common answer
 * shape, „hängt von der Gebäudeklasse ab".
 *
 * The deciding factor (`question`) reads as the stem; each branch pairs its
 * case with the outcome that holds under it, and the branch that applies to the
 * current project is marked `active` (tinted + a „trifft zu" chip) so the reader
 * sees their answer without re-deriving the whole tree. Exactly the structure
 * that otherwise becomes nested prose.
 */

import { type FC } from 'react'
import { GitBranch, CornerDownRight } from 'lucide-react'
import { SchematicCard } from '../schematics/kit'
import { statusColor } from '../schematics/kit'
import { cn } from '@/lib/utils'
import type { ConditionBranchData, NormReferenceData } from '../schematics/types'

interface ConditionTreeCardProps {
  title: string
  question: string
  branches: ConditionBranchData[]
  reference?: NormReferenceData | null
}

/** "OIB-Richtlinie 2 · Tabelle 1b" — compact inline citation for one branch. */
const shortRef = (ref: NormReferenceData): string =>
  ref.section ? `${ref.document} · ${ref.section}` : ref.document

export const ConditionTreeCard: FC<ConditionTreeCardProps> = ({
  title,
  question,
  branches,
  reference,
}) => {
  const activeTint = statusColor('pass')

  return (
    <SchematicCard icon={GitBranch} eyebrow="Bedingungsbaum" title={title} reference={reference}>
      <p className="text-xs text-muted-foreground">
        Abhängig von: <span className="font-medium text-foreground">{question}</span>
      </p>

      <ul className="flex flex-col gap-2">
        {branches.map((branch, index) => {
          const active = branch.active === true
          return (
            <li
              key={`${branch.condition}-${index}`}
              className={cn(
                'flex flex-col gap-1 rounded-md border px-3 py-2',
                active ? 'border-transparent' : 'border-border/60',
              )}
              style={
                active
                  ? { backgroundColor: `color-mix(in oklch, ${activeTint} 10%, transparent)` }
                  : undefined
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
                  {branch.condition}
                </span>
                {active && (
                  <span
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{
                      color: activeTint,
                      backgroundColor: `color-mix(in oklch, ${activeTint} 14%, transparent)`,
                    }}
                  >
                    trifft zu
                  </span>
                )}
              </div>
              <div className="flex items-start gap-1.5">
                <CornerDownRight
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    'text-[13.5px] leading-[1.55] text-default',
                    active && 'font-medium',
                  )}
                >
                  {branch.outcome}
                </span>
                {branch.reference && (
                  <span className="ml-auto shrink-0 whitespace-nowrap rounded-md bg-source-law-tint px-2 py-[3px] text-[11px] text-source-law-text">
                    {shortRef(branch.reference)}
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </SchematicCard>
  )
}
