'use client'

/**
 * The plan a run waits on, on the run's own block (ADR-0065).
 *
 * Three readings of one row, and the reader owes none of them an answer:
 *
 * - **Proposed.** The brief at a glance — title, facts, the first sections
 *   as an outline, the documents it reads — and a bar draining toward the
 *   start: the run starts on its own. „Anpassen" stops the clock and opens the plan as controls; „Jetzt
 *   starten" skips the wait. Doing nothing is a complete answer.
 * - **Held.** The plan as controls — sections, genre, depth, Unterlagen — and
 *   „Starten". Every edit is saved as it is made.
 * - **Started.** The brief the run is running, read-only and folded.
 */

import { useEffect, useState, type FC } from 'react'
import {
  Ban,
  ChevronDown,
  CircleCheck,
  Crosshair,
  CloudCheck,
  ListOrdered,
  LoaderCircle,
  Play,
  SlidersHorizontal,
} from 'lucide-react'
import { AnimatePresence, Swap } from '@/components/motion'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import type { ResearchPlan, ResearchPlanEdit } from '@/lib/plans/plan-types'
import { cn } from '@/lib/utils'
import { PlanBrief } from './PlanBrief'
import { PlanChecklist, planShapeOf, type PlanRahmen, type PlanShape } from './PlanChecklist'
import {
  CountdownBar,
  DEPTH_ICON,
  GENRE_ICON,
  GenreWell,
  PlanEyebrow,
  PlanFacts,
  PlanAction,
  PlanLifecycle,
} from './plan-atoms'

export interface RunPlanProps {
  plan: ResearchPlan
  rahmen?: PlanRahmen
  /** The project whose listing the document step offers. */
  projectId?: string | null
  pending?: boolean
  onEdit?: ((edit: ResearchPlanEdit) => void | Promise<void>) | null
  onHold?: (() => void | Promise<void>) | null
  onStart?: (() => void | Promise<void>) | null
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index])

const fold = (name: string): string => name.trim().toLocaleLowerCase()

/**
 * Only what changed, so an edit never re-sends what the reader left alone.
 * A document named from the project listing, which the plan's inventory did
 * not hold, travels with the names so the BFF can resolve it.
 */
export function planEdit(before: PlanShape, after: PlanShape): ResearchPlanEdit {
  const known = new Set(before.unterlagen.map((doc) => fold(doc.name)))
  const named = new Set([...after.grundlage, ...after.ausgeschlossen].map(fold))
  const brought = after.unterlagen.filter((doc) => !known.has(fold(doc.name)) && named.has(fold(doc.name)))
  return {
    ...(sameList(before.sections, after.sections) ? {} : { sections: after.sections }),
    ...(before.genre === after.genre ? {} : { genre: after.genre }),
    ...(before.depth === after.depth ? {} : { depth: after.depth }),
    ...(sameList(before.grundlage, after.grundlage) ? {} : { grundlage: after.grundlage }),
    ...(sameList(before.ausgeschlossen, after.ausgeschlossen) ? {} : { ausgeschlossen: after.ausgeschlossen }),
    ...(before.nurGrundlage === after.nurGrundlage ? {} : { nurGrundlage: after.nurGrundlage }),
    ...(brought.length > 0 ? { unterlagen: brought } : {}),
  }
}

/** Whole seconds until `startsAt`, never negative; null without a clock. */
function secondsUntil(startsAt: string | null, now: number): number | null {
  if (!startsAt) return null
  const at = Date.parse(startsAt)
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000))
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** How much of the grace is left, 0–1; null without a clock. */
function remainingFraction(plan: ResearchPlan, now: number): number | null {
  if (!plan.startsAt) return null
  const end = Date.parse(plan.startsAt)
  const start = Date.parse(plan.heldAt ?? plan.createdAt)
  if (Number.isNaN(end) || Number.isNaN(start) || end <= start) return null
  return Math.max(0, Math.min(1, (end - now) / (end - start)))
}

/** Rows of the outline shown while the plan is folded. */
const PREVIEW_ROWS = 4

export const RunPlan: FC<RunPlanProps> = ({
  plan,
  rahmen,
  projectId = null,
  pending = false,
  onEdit,
  onHold,
  onStart,
}) => {
  const t = useTranslations('runs')
  const tc = useTranslations('chat')
  const shape = planShapeOf(plan)
  const [open, setOpen] = useState(plan.status === 'held')
  const counting = plan.status === 'proposed' && plan.startsAt !== null
  const now = useNow(counting)
  const seconds = secondsUntil(plan.startsAt, now)
  const remaining = counting ? remainingFraction(plan, now) : null
  const editable = plan.status === 'proposed' || plan.status === 'held' || plan.status === 'approved'
  const started = plan.status === 'started'

  useEffect(() => {
    if (plan.status === 'held') setOpen(true)
  }, [plan.status])

  const facts = [
    { icon: GENRE_ICON[plan.genre], label: tc(`agentPrompt.plan.genres.${plan.genre}`) },
    { icon: DEPTH_ICON[plan.depth], label: tc(`agentPrompt.plan.depths.${plan.depth}`) },
    { icon: ListOrdered, label: t('plan.sections', { count: plan.sections.length }) },
    ...(plan.grundlage.length > 0
      ? [
          plan.nurGrundlage
            ? { icon: CircleCheck, label: t('plan.documentsOnly', { count: plan.grundlage.length }) }
            : { icon: Crosshair, label: t('plan.documents', { count: plan.grundlage.length }) },
        ]
      : []),
    ...(plan.ausgeschlossen.length > 0
      ? [{ icon: Ban, label: t('plan.excluded', { count: plan.ausgeschlossen.length }) }]
      : []),
  ]
  const editing = open && editable && Boolean(onEdit)

  const line =
    plan.status === 'proposed'
      ? seconds && seconds > 0
        ? t('plan.startsIn', { seconds })
        : t('plan.startsNow')
      : plan.status === 'held'
        ? t('plan.held')
        : plan.status === 'approved'
          ? t('plan.approved')
          : t('plan.started')

  return (
    <div
      className="border-border flex flex-col gap-3 border-t px-3 py-3"
      data-testid="run-plan"
      data-status={plan.status}
    >
      <div className="flex items-start gap-3">
        <GenreWell genre={plan.genre} />
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="focus-visible:ring-ring/60 flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2"
          data-testid="run-plan-toggle"
        >
          <span className="flex items-center gap-1.5">
            <PlanEyebrow>{t(plan.author === 'user' ? 'plan.headingOwn' : 'plan.heading')}</PlanEyebrow>
            {started && <CircleCheck className="text-muted-foreground size-3" aria-hidden />}
          </span>
          <span className="text-foreground flex w-full min-w-0 items-center gap-1 text-sm font-semibold">
            <span className="truncate">{plan.title}</span>
            <ChevronDown
              className={cn(
                'text-muted-foreground size-3.5 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
                open && 'rotate-180'
              )}
              aria-hidden
            />
          </span>
          <PlanFacts facts={facts} />
        </button>
        {/* The actions change with the status: „Anpassen" leaves once the clock
            is stopped, „Jetzt starten" becomes the primary „Starten". Each
            enters and leaves on its own; the other glides over. */}
        <span className="flex shrink-0 gap-1">
          <AnimatePresence initial={false} mode="popLayout">
            {plan.status === 'proposed' && onHold && (
              <PlanAction key="hold">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={pending}
                  onClick={() => {
                    setOpen(true)
                    void onHold()
                  }}
                  data-testid="run-plan-hold"
                >
                  <SlidersHorizontal className="size-3.5" aria-hidden />
                  {t('plan.adjust')}
                </Button>
              </PlanAction>
            )}
            {(plan.status === 'proposed' || plan.status === 'held') && onStart && (
              <PlanAction key={plan.status === 'held' ? 'start' : 'start-now'}>
                <Button
                  size="sm"
                  variant={plan.status === 'held' ? 'default' : 'outline'}
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={pending}
                  onClick={() => void onStart()}
                  data-testid="run-plan-start"
                >
                  <Play className="size-3.5" aria-hidden />
                  {plan.status === 'held' ? t('plan.start') : t('plan.startNow')}
                </Button>
              </PlanAction>
            )}
          </AnimatePresence>
        </span>
      </div>

      <div className="flex flex-col gap-1.5 sm:pl-12">
        {/* The clock while it runs, then where the plan stands: one gives way
            to the other in the same place. The line changes with the status,
            not with every second the clock ticks. */}
        <Swap swapKey={remaining !== null ? `clock-${plan.startsAt}` : `stage-${plan.status}`} distance={0}>
          {remaining !== null ? (
            <CountdownBar remaining={remaining} seconds={seconds ?? 0} label={line} />
          ) : (
            plan.status !== 'superseded' && (
              <PlanLifecycle
                stage={plan.status}
                labels={{
                  proposed: t('plan.stage.proposed'),
                  held: t('plan.stage.held'),
                  approved: t('plan.stage.approved'),
                  started: t('plan.stage.started'),
                }}
              />
            )
          )}
        </Swap>
        <Swap swapKey={plan.status}>
          <p
            className="text-muted-foreground text-xs"
            role={counting ? 'timer' : 'status'}
            data-testid="run-plan-line"
          >
            {line}
          </p>
        </Swap>
        {editing && (
          <p className="text-muted-foreground inline-flex items-center gap-1 text-[11px]" data-testid="run-plan-saved">
            <Swap swapKey={pending ? 'saving' : 'saved'} distance={0} className="flex">
              {pending ? (
                <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <CloudCheck className="size-3" aria-hidden />
              )}
            </Swap>
            {pending ? t('plan.saving') : t('plan.saved')}
          </p>
        )}
      </div>

      {/* The brief gives way to its editor at once when „Anpassen" is pressed:
          the editor is there under the reader's hand while the brief fades out
          over it. */}
      <Swap swapKey={editing ? 'editor' : 'brief'} mode="popLayout" className="relative sm:pl-12">
        {editing && onEdit ? (
          <PlanChecklist
            plan={shape}
            rahmen={rahmen}
            projectId={projectId}
            onChange={(next) => {
              const edit = planEdit(shape, next)
              if (Object.keys(edit).length > 0) void onEdit(edit)
            }}
          />
        ) : (
          <PlanBrief
            sections={plan.sections}
            grundlage={plan.grundlage}
            ausgeschlossen={plan.ausgeschlossen}
            nurGrundlage={plan.nurGrundlage}
            limit={open ? undefined : PREVIEW_ROWS}
            onMore={() => setOpen(true)}
            testId={open ? 'run-plan-sections' : 'run-plan-preview'}
          />
        )}
      </Swap>
    </div>
  )
}
