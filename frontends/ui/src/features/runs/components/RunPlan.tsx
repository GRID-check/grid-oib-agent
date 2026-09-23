'use client'

/**
 * The plan a run waits on, on the run's own block (ADR-0065).
 *
 * Three readings of one row, and the reader owes none of them an answer:
 *
 * - **Proposed.** A one-line summary and a countdown: the run starts on its
 *   own. „Anpassen" stops the clock and opens the plan as controls; „Jetzt
 *   starten" skips the wait. Doing nothing is a complete answer.
 * - **Held.** The plan as controls — sections, genre, depth, Unterlagen — and
 *   „Starten". Every edit is saved as it is made.
 * - **Started.** The brief the run is running, read-only and folded.
 */

import { useEffect, useState, type FC } from 'react'
import { ChevronDown, ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import type { ResearchPlan, ResearchPlanEdit } from '@/lib/plans/plan-types'
import { cn } from '@/lib/utils'
import { PlanChecklist, planShapeOf, type PlanRahmen, type PlanShape } from './PlanChecklist'

export interface RunPlanProps {
  plan: ResearchPlan
  rahmen?: PlanRahmen
  pending?: boolean
  onEdit?: ((edit: ResearchPlanEdit) => void | Promise<void>) | null
  onHold?: (() => void | Promise<void>) | null
  onStart?: (() => void | Promise<void>) | null
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index])

/** Only what changed, so an edit never re-sends what the reader left alone. */
export function planEdit(before: PlanShape, after: PlanShape): ResearchPlanEdit {
  return {
    ...(sameList(before.sections, after.sections) ? {} : { sections: after.sections }),
    ...(before.genre === after.genre ? {} : { genre: after.genre }),
    ...(before.depth === after.depth ? {} : { depth: after.depth }),
    ...(sameList(before.grundlage, after.grundlage) ? {} : { grundlage: after.grundlage }),
    ...(sameList(before.ausgeschlossen, after.ausgeschlossen) ? {} : { ausgeschlossen: after.ausgeschlossen }),
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

export const RunPlan: FC<RunPlanProps> = ({ plan, rahmen, pending = false, onEdit, onHold, onStart }) => {
  const t = useTranslations('runs')
  const tc = useTranslations('chat')
  const shape = planShapeOf(plan)
  const [open, setOpen] = useState(plan.status === 'held')
  const counting = plan.status === 'proposed' && plan.startsAt !== null
  const now = useNow(counting)
  const seconds = secondsUntil(plan.startsAt, now)
  const editable = plan.status === 'proposed' || plan.status === 'held' || plan.status === 'approved'

  useEffect(() => {
    if (plan.status === 'held') setOpen(true)
  }, [plan.status])

  const summary = t('plan.summary', {
    genre: tc(`agentPrompt.plan.genres.${plan.genre}`),
    depth: tc(`agentPrompt.plan.depths.${plan.depth}`),
    count: plan.sections.length,
  })

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
      className="border-border flex flex-col gap-2 border-t px-3 py-2"
      data-testid="run-plan"
      data-status={plan.status}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="text-foreground focus-visible:ring-ring/60 flex min-w-0 items-center gap-1.5 rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-2"
          data-testid="run-plan-toggle"
        >
          <ListChecks className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <span className="truncate">{t(plan.author === 'user' ? 'plan.headingOwn' : 'plan.heading')}</span>
          <span className="text-muted-foreground truncate font-normal">· {summary}</span>
          <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        <span className="ml-auto flex shrink-0 gap-1">
          {plan.status === 'proposed' && onHold && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={pending}
              onClick={() => {
                setOpen(true)
                void onHold()
              }}
              data-testid="run-plan-hold"
            >
              {t('plan.adjust')}
            </Button>
          )}
          {(plan.status === 'proposed' || plan.status === 'held') && onStart && (
            <Button
              size="sm"
              variant={plan.status === 'held' ? 'default' : 'outline'}
              className="h-7 px-2 text-xs"
              disabled={pending}
              onClick={() => void onStart()}
              data-testid="run-plan-start"
            >
              {plan.status === 'held' ? t('plan.start') : t('plan.startNow')}
            </Button>
          )}
        </span>
      </div>
      <p className="text-muted-foreground text-xs" role={counting ? 'timer' : 'status'} data-testid="run-plan-line">
        {line}
      </p>
      {open &&
        (editable && onEdit ? (
          <PlanChecklist
            plan={shape}
            disabled={pending}
            rahmen={rahmen}
            onChange={(next) => {
              const edit = planEdit(shape, next)
              if (Object.keys(edit).length > 0) void onEdit(edit)
            }}
          />
        ) : (
          <ol className="text-foreground list-decimal pl-5 text-sm" data-testid="run-plan-sections">
            {plan.sections.map((section) => (
              <li key={section}>{section}</li>
            ))}
          </ol>
        ))}
    </div>
  )
}
