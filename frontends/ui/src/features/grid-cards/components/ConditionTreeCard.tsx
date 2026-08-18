'use client'

/**
 * ConditionTreeCard — a Bedingungsbaum for the domain's most common answer
 * shape, „hängt von der Gebäudeklasse ab".
 *
 * The deciding factor (`question`) is drawn as the root of a real tree: a
 * stem node with a rail descending into each case, so the reader sees „the
 * answer forks here, on this" at a glance rather than parsing a stack of equal
 * grey boxes. Each case hangs off the rail as a branch; the one that applies to
 * the current project is `active` (tinted node + „trifft zu" chip), so the
 * reader finds their answer without re-deriving the whole tree.
 *
 * Branches are DISCLOSURES, not static rows: collapsed, a branch reads as
 * `condition → outcome` on one line; expanding it (the user's own ask, „ich
 * klick das und sehe mehr") lets the outcome breathe and reveals the norm the
 * branch rests on. This is presentational state only — a `useState` per
 * branch — never a persisted `useCardDecision`: opening a branch changes what
 * this reader sees, it does not decide anything or reach the backend. The
 * active branch starts open because it is already the reader's answer; the
 * detail that justifies it should be in view without a click.
 */

import { useState, type FC } from 'react'
import { GitBranch, ChevronDown, Scale } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SchematicCard, statusColor } from '../schematics/kit'
import { cn } from '@/lib/utils'
import type { ConditionBranchData, NormReferenceData } from '../schematics/types'

interface ConditionTreeCardProps {
  title: string
  question: string
  branches: ConditionBranchData[]
  reference?: NormReferenceData | null
}

/**
 * The norm a single branch rests on, revealed on expand. Echoes
 * `NormRefFooter`'s visual language (Scale glyph + document + section) but at
 * branch scale and in the source-law tint, so a reader can tell at a glance
 * that the „mehr" they clicked for is a citation, not more prose.
 */
const BranchReference: FC<{ reference: NormReferenceData }> = ({ reference }) => (
  <div className="flex flex-col gap-1.5 rounded-md bg-source-law-tint px-3 py-2 text-source-law-text">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <Scale className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-[11px] font-medium uppercase tracking-wider opacity-70">Grundlage</span>
      <span className="font-medium">{reference.document}</span>
      {reference.section && <span className="font-mono opacity-90">{reference.section}</span>}
      {reference.edition && <span className="opacity-70">{reference.edition}</span>}
    </div>
    {reference.excerpt && (
      <blockquote className="max-w-prose border-l-2 border-source-law-text/30 pl-2.5 text-xs italic leading-relaxed opacity-90">
        {reference.excerpt}
      </blockquote>
    )}
  </div>
)

/**
 * One branch off the stem: the rail + node are drawn behind the content, the
 * `condition → outcome` line is the disclosure trigger, and the norm reveals
 * below on expand.
 */
const BranchNode: FC<{ branch: ConditionBranchData; isLast: boolean }> = ({ branch, isLast }) => {
  const active = branch.active === true
  const [open, setOpen] = useState(active)
  const tint = statusColor('pass')

  return (
    <li className="relative grid grid-cols-[22px_minmax(0,1fr)]">
      {/* Rail, elbow and node are pure decoration drawn in the 22px gutter, so
          the connector reads as a tree and never intercepts the click. The
          rail stops at the node on the last branch — nothing hangs below it. */}
      <span
        aria-hidden="true"
        className={cn('absolute left-[7px] top-0 w-px bg-border', isLast ? 'h-[15px]' : 'bottom-0')}
      />
      <span aria-hidden="true" className="absolute left-[7px] top-[15px] h-px w-3 bg-border" />
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-[7px] top-[15px] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full',
          active ? 'border-2 border-transparent' : 'border-2 border-border bg-card',
        )}
        style={active ? { backgroundColor: tint } : undefined}
      />

      <div className="col-start-2 min-w-0 pb-1.5">
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className={cn(
              'group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left',
              'transition-colors duration-quick ease-out',
              'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
              active ? 'hover:bg-transparent' : 'hover:bg-muted/50',
            )}
            style={
              active
                ? { backgroundColor: `color-mix(in oklch, ${tint} 9%, transparent)` }
                : undefined
            }
          >
            <span className="mt-px shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {branch.condition}
            </span>
            {/* Clamped closed, unclamped open — the outcome's „room to breathe"
                is the same text finding its full height, not a second copy. */}
            <span
              className={cn(
                'min-w-0 flex-1 text-[13.5px] leading-[1.5] text-default',
                !open && 'line-clamp-1',
                active && 'font-medium',
              )}
            >
              {branch.outcome}
            </span>
            {active && (
              <span
                className="mt-px shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{
                  color: tint,
                  backgroundColor: `color-mix(in oklch, ${tint} 14%, transparent)`,
                }}
              >
                trifft zu
              </span>
            )}
            <ChevronDown
              className={cn(
                'mt-0.5 size-4 shrink-0 text-muted-foreground',
                'transition-transform duration-quick ease-out motion-reduce:transition-none',
                open && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </CollapsibleTrigger>

          <CollapsibleContent className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
            {branch.reference && (
              <div className="mt-1.5 pl-2 pr-2">
                <BranchReference reference={branch.reference} />
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </li>
  )
}

export const ConditionTreeCard: FC<ConditionTreeCardProps> = ({
  title,
  question,
  branches,
  reference,
}) => (
  <SchematicCard icon={GitBranch} eyebrow="Bedingungsbaum" title={title} reference={reference}>
    <div className="flex flex-col">
      {/* Root of the tree: the deciding factor, with the rail dropping out of
          its node into the branches below. */}
      <div className="relative grid grid-cols-[22px_minmax(0,1fr)]">
        <span aria-hidden="true" className="absolute left-[7px] top-[11px] bottom-0 w-px bg-border" />
        <span
          aria-hidden="true"
          className="absolute left-[7px] top-[11px] size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
        />
        <div className="col-start-2 flex flex-col pl-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Abhängig von
          </span>
          <span className="text-sm font-semibold text-foreground">{question}</span>
        </div>
      </div>

      <ul className="mt-1.5 flex flex-col">
        {branches.map((branch, index) => (
          <BranchNode
            key={`${branch.condition}-${index}`}
            branch={branch}
            isLast={index === branches.length - 1}
          />
        ))}
      </ul>
    </div>
  </SchematicCard>
)
