'use client'

/**
 * ConditionTreeCard — a Bedingungsbaum for the domain's most common answer
 * shape, „hängt von der Gebäudeklasse ab".
 *
 * The deciding factor (`question`) is drawn as the root of a real tree: a
 * stem node with a rail descending into each case, so the reader sees „the
 * answer forks here, on this" at a glance rather than parsing a stack of equal
 * grey boxes. Each case hangs off the rail as a branch; the one that applies to
 * the current project is `active`, so the reader finds their answer without
 * re-deriving the whole tree.
 *
 * Every other case is ALSO already on the client, and „Was gilt bei GK 3?" is
 * the question the card provokes. So the branches are one open at a time — a
 * selection, not five independent disclosures — and the open one shows its
 * outcome large, in full, with the norm it rests on. Picking another case
 * answers that question from what is already on screen: no turn, no fetch, no
 * decision („ich klick das und sehe mehr"). It is a single `useState` holding
 * an index, never a persisted `useCardDecision`, because looking at another
 * case changes what this reader sees and commits them to nothing.
 *
 * The failure mode this card has to survive is a reader screenshotting the
 * wrong case into a Einreichung, so the marking of the case that APPLIES is
 * made independent of what is being looked at, four times over:
 *
 *   1. The active branch keeps its tinted node, its „trifft zu" chip, its
 *      weight and its `aria-current` at all times — the chip never moves to
 *      the previewed branch, and the active outcome stays legible in the row
 *      even while another branch is open, so it is inside any screenshot of
 *      the card.
 *   2. The open panel of a non-active branch is written in the Konjunktiv
 *      („Bei GK 3 würde gelten"), against the indicative the active branch
 *      gets („Für dieses Projekt gilt"). The distinction is in the German
 *      itself, so it survives cropping, greyscale and colour blindness.
 *   3. That panel carries the correcting sentence INSIDE it — „Nur zum
 *      Vergleich — für dieses Projekt gilt GK 4: REI 60" — naming the case
 *      that does apply and its outcome, so a screenshot of just the panel
 *      still says what this project is.
 *   4. Its chrome differs in kind, not only in tint: dashed border and a muted
 *      ground versus the solid, tinted panel of the active case.
 */

import { useState, type FC } from 'react'
import { GitBranch, ChevronDown, Info, Scale } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations, type Translator } from '@/i18n'
import { SchematicCard, statusColor } from '../cards/shell'
import { cn } from '@/lib/utils'
import { CARD_LIST_ROW, CARD_ROW_BACK_LINK } from './card-rows'
import type { ConditionBranchData, NormReferenceData } from '../schematics/types'

interface ConditionTreeCardProps {
  title: string
  question: string
  branches: ConditionBranchData[]
  reference?: NormReferenceData | null
}

/**
 * The norm a single branch rests on, revealed with the branch. Echoes
 * `NormRefFooter`'s visual language (Scale glyph + document + section) but at
 * branch scale and in the source-law tint, so a reader can tell at a glance
 * that the „mehr" they clicked for is a citation, not more prose.
 */
const BranchReference: FC<{ reference: NormReferenceData; label: string }> = ({
  reference,
  label,
}) => (
  <div className="flex flex-col gap-1.5 rounded-md bg-source-law-tint px-3 py-2 text-source-law-text">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <Scale className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-[11px] font-medium uppercase tracking-wider opacity-70">{label}</span>
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

interface BranchNodeProps {
  branch: ConditionBranchData
  /**
   * Whether THIS branch is the project's case.
   *
   * Passed in rather than read off `branch.active`, because the card must show
   * at most one. A stored card can carry more than one `active` — the backend
   * validator that now rejects it did not exist when older cards were written,
   * and a card is data that outlives the code that made it. Field evidence:
   * a „Feuerwiderstand in GK 4" tree arrived with all three branches active,
   * so the reader saw three simultaneous outcomes each captioned „für dieses
   * Projekt gilt". The parent resolves ONE index and every branch is told
   * whether it is that one.
   */
  active: boolean
  isLast: boolean
  open: boolean
  onToggle: () => void
  /** The case that applies to this project, when one is marked — else null. */
  activeBranch: ConditionBranchData | null
  /** Jump back to that case. Absent when this branch IS it, or none is marked. */
  onBackToActive?: () => void
  t: Translator
}

/**
 * One branch off the stem: the rail + node are drawn behind the content, the
 * `condition → outcome` line is the trigger, and the case opens below it.
 */
const BranchNode: FC<BranchNodeProps> = ({
  branch,
  active,
  isLast,
  open,
  onToggle,
  activeBranch,
  onBackToActive,
  t,
}) => {
  const tint = statusColor('pass')

  // Indicative for the case that applies, Konjunktiv for a case being looked
  // at against it, plain indicative again when nothing is marked active and
  // there is therefore no „instead of" to signal.
  const lead = active
    ? t('cards.conditionTree.appliesHere')
    : activeBranch
      ? t('cards.conditionTree.previewLead', { condition: branch.condition })
      : t('cards.conditionTree.caseLead', { condition: branch.condition })

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
        <Collapsible open={open} onOpenChange={onToggle}>
          <CollapsibleTrigger
            // The case that applies is the current item of the set whatever is
            // being looked at, so the marking is in the semantics too, not
            // only in the tint and the chip.
            aria-current={active ? 'true' : undefined}
            className={cn(
              CARD_LIST_ROW,
              'transition-colors duration-quick ease-out motion-reduce:transition-none',
              'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
              active ? 'hover:bg-transparent' : open ? 'bg-muted/60' : 'hover:bg-muted/50',
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
            {/* One line in the row whether open or closed: the row is the index
                of the tree, and the open case gets its full outcome in the
                panel below. Keeping the ACTIVE row readable at all times is
                what puts this project's answer inside every screenshot. */}
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[13.5px] leading-[1.5] text-default',
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
                {t('cards.conditionTree.applies')}
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
            <div
              className={cn(
                'mt-1.5 flex flex-col gap-2 rounded-md border px-3 py-2.5',
                // Chrome differs in KIND, not only in tint: a dashed outline on
                // a muted ground for a case being looked at, a solid tinted
                // panel for the one that applies.
                active ? 'border-transparent' : 'border-dashed bg-muted/30',
              )}
              style={
                active
                  ? {
                      borderColor: `color-mix(in oklch, ${tint} 30%, transparent)`,
                      backgroundColor: `color-mix(in oklch, ${tint} 6%, transparent)`,
                    }
                  : undefined
              }
            >
              <span
                className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                style={active ? { color: tint } : undefined}
              >
                {lead}
              </span>
              <p className="max-w-prose text-[15px] font-medium leading-snug text-foreground">
                {branch.outcome}
              </p>

              {!active && activeBranch && (
                // The correction rides INSIDE the panel, so it is in the same
                // rectangle a reader would crop out and paste into a
                // submission. It names the case that applies AND its outcome —
                // a bare „this is not your case" would leave them to look it up
                // again, which is how the wrong one gets screenshotted.
                <div className="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md bg-card px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {/* The correcting sentence claims 12rem before the row is
                      allowed to keep the way-back button beside it. With a
                      plain `flex-1` the button held its width on a phone and
                      the sentence wrapped into a four-line column beside it;
                      now it takes the full width and the button drops to its
                      own line. */}
                  <span className="min-w-0 flex-[1_1_12rem]">
                    {t('cards.conditionTree.previewNotice', {
                      condition: activeBranch.condition,
                      outcome: activeBranch.outcome,
                    })}
                  </span>
                  {onBackToActive && (
                    <button
                      type="button"
                      onClick={onBackToActive}
                      className={cn(
                        CARD_ROW_BACK_LINK,
                        'transition-opacity duration-quick ease-out motion-reduce:transition-none',
                        'hover:opacity-80',
                        'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
                      )}
                    >
                      {t('cards.conditionTree.backToActive', { condition: activeBranch.condition })}
                    </button>
                  )}
                </div>
              )}

              {branch.reference && (
                <BranchReference
                  reference={branch.reference}
                  label={t('cards.conditionTree.basis')}
                />
              )}
            </div>
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
}) => {
  const t = useTranslations('chat')
  // The FIRST branch marked active, and only that one. The backend now rejects
  // a tree marking several, but a card is data that outlives the code that
  // wrote it: a stored answer from before the validator can still carry three,
  // and three cases each captioned „für dieses Projekt gilt" tells the reader a
  // decision was made when none was — worse than showing no card at all.
  const activeIndex = branches.findIndex((branch) => branch.active === true)
  const activeBranch = activeIndex >= 0 ? branches[activeIndex] : null

  // One case open at a time. The active one starts open because it is already
  // the reader's answer; with none marked, the tree opens closed rather than
  // picking a case on the reader's behalf.
  const [openIndex, setOpenIndex] = useState<number | null>(
    activeIndex >= 0 ? activeIndex : null,
  )

  return (
    <SchematicCard
      icon={GitBranch}
      eyebrow={t('cards.conditionTree.eyebrow')}
      title={title}
      reference={reference}
    >
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
              {t('cards.conditionTree.dependsOn')}
            </span>
            <span className="text-sm font-semibold text-foreground">{question}</span>
          </div>
        </div>

        <ul className="mt-1.5 flex flex-col">
          {branches.map((branch, index) => (
            <BranchNode
              key={`${branch.condition}-${index}`}
              branch={branch}
              active={index === activeIndex}
              isLast={index === branches.length - 1}
              open={openIndex === index}
              onToggle={() => setOpenIndex((current) => (current === index ? null : index))}
              activeBranch={activeBranch}
              onBackToActive={
                activeIndex >= 0 && activeIndex !== index
                  ? () => setOpenIndex(activeIndex)
                  : undefined
              }
              t={t}
            />
          ))}
        </ul>
      </div>
    </SchematicCard>
  )
}
