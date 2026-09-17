'use client'

/**
 * The check step: run the reviewer, and see where what it found still lives.
 *
 * Why this is a model and not a linter: the question that actually decides
 * whether a skill works is "will this description match the requests people
 * make?", and that is a question about meaning. A regex can check that a
 * description is non-empty and under 1024 characters — which the save already
 * enforces — but not that it is specific enough to be selected over every other
 * skill in the org. So the check is the same kind of thing it is checking.
 *
 * ## It no longer holds the findings
 *
 * It used to render the whole list under its own heading, which put the
 * critique of the DESCRIPTION two steps away from the description. Revising
 * meant walking back with the advice held in your head and walking forward
 * again to see whether you had addressed it.
 *
 * The findings now sit under the fields they are about (`SkillFindingList`,
 * inline, on steps 1 and 2). What is left here is what is genuinely about the
 * whole draft: has it been read, what came back, and WHERE the open findings
 * are — each row a way to the step that holds them. The verdict stays one
 * object; only its parts are shown where they can be acted on.
 *
 * ## Required to RUN, never required to pass
 *
 * The save waits until the check has been run on the draft as it currently
 * stands. Editing after a check makes the verdict stale and closes the gate
 * again, because a verdict on an older text is not a verdict on this one — and
 * the button then says „Erneut prüfen" rather than „Skill prüfen", because by
 * then re-running is the whole job.
 *
 * What the findings SAY changes nothing. They are a model's opinion about
 * whether a description will be matched, and a save blocked on a model's
 * opinion is the same forcing this codebase spent ADR-0060 removing, turned
 * around to point at the author. The requirement is that somebody looked.
 *
 * A reviewer that could not run also lets the save through. „You must have
 * looked" is a claim about the author; „the model must be reachable" would be
 * a claim about our infrastructure, and paying for our outage with their
 * unsaveable draft is not a trade we get to make.
 *
 * Reviewing is not a privileged action — the same panel appears for anyone who
 * can open the editor, because the person most likely to write a description
 * that never matches anything is the person writing their first skill.
 */

import type { FC } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { SkillReviewFinding } from '@/adapters/api/skills-client'
import type { SkillReviewField, SkillReviewState } from '../hooks/use-skill-review'

export interface SkillReviewPanelProps {
  state: SkillReviewState
  /** The draft has moved on since the verdict on screen. */
  stale: boolean
  findings: readonly SkillReviewFinding[]
  onRun: () => void
  /**
   * Go to the step that holds this field. Omit and the summary is read-only —
   * the panel never navigates a surface that did not offer to be navigated.
   */
  onGoToField?: (field: SkillReviewField) => void
  className?: string
}

/** The order the summary lists fields in: the order the builder asks for them. */
const FIELD_ORDER: readonly SkillReviewField[] = ['name', 'description', 'body']

export const SkillReviewPanel: FC<SkillReviewPanelProps> = ({
  state,
  stale,
  findings,
  onRun,
  onGoToField,
  className,
}) => {
  const t = useTranslations('skills')
  const running = state.kind === 'running'
  // „Erneut prüfen" once a verdict exists, because by then re-running IS the
  // job — the author has revised and wants to know whether it took.
  const ranBefore = state.kind === 'done' || state.kind === 'unavailable'
  const actionLabel = ranBefore ? t('editor.review.again') : t('editor.review.action')

  const open = FIELD_ORDER.map((field) => ({
    field,
    count: findings.filter((finding) => finding.field === field).length,
  })).filter((row) => row.count > 0)

  return (
    <section
      className={cn('flex flex-col gap-2', className)}
      aria-labelledby="skill-review-heading"
      data-testid="skill-review-panel"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id="skill-review-heading" className="text-sm font-medium">
          {t('editor.review.heading')}
        </h3>
        <Button
          type="button"
          variant={stale && ranBefore ? 'default' : 'outline'}
          size="sm"
          onClick={onRun}
          disabled={running}
          aria-busy={running}
          className="h-8 px-3.5 text-xs"
          data-testid="skill-review-run"
        >
          {/* Both labels stay mounted so the button does not change width when
              it starts working. */}
          <span className="inline-grid justify-items-start">
            <span
              className={cn(
                'col-start-1 row-start-1 inline-flex items-center gap-1.5',
                running && 'invisible',
              )}
              aria-hidden={running}
            >
              {actionLabel}
            </span>
            <span
              className={cn(
                'col-start-1 row-start-1 inline-flex items-center gap-1.5',
                !running && 'invisible',
              )}
              aria-hidden={!running}
            >
              <Spinner size="sm" aria-hidden />
              {t('editor.review.running')}
            </span>
          </span>
        </Button>
      </div>

      <p className="text-muted-foreground text-xs">{t('editor.review.subtitle')}</p>

      {/* The verdict is stale and the author has not re-run yet: the one thing
          this panel must not do is let that pass quietly, because everything
          on screen is then about a draft that no longer exists. */}
      {stale && ranBefore && (
        <p
          className="text-foreground animate-in fade-in-0 rounded-lg border border-dashed px-3 py-2 text-xs duration-base ease-out motion-reduce:animate-none"
          role="status"
          data-testid="skill-review-stale"
        >
          {t('editor.review.staleAction')}
        </p>
      )}

      {state.kind === 'unavailable' && !stale && (
        <p
          className="text-muted-foreground animate-in fade-in-0 rounded-lg border border-dashed px-3 py-2 text-xs duration-base ease-out motion-reduce:animate-none"
          role="status"
          data-testid="skill-review-unavailable"
        >
          {/* Explicitly NOT "looks good": the reviewer never ran. */}
          {t('editor.review.unavailable')}
        </p>
      )}

      {state.kind === 'done' && findings.length === 0 && !stale && (
        <p
          className="text-foreground animate-in fade-in-0 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs duration-base ease-out motion-reduce:animate-none"
          role="status"
          data-testid="skill-review-clean"
        >
          <Check className="text-success mt-px size-3.5 shrink-0" aria-hidden />
          {t('editor.review.clean')}
        </p>
      )}

      {/* WHERE the open findings are, not what they say — they say it beside
          the field they are about, which is where they can be acted on. Each
          row is the way there. */}
      {state.kind === 'done' && open.length > 0 && !stale && (
        <ul className="flex flex-col gap-1.5" data-testid="skill-review-summary">
          {open.map(({ field, count }) => (
            <li key={field}>
              <button
                type="button"
                onClick={() => onGoToField?.(field)}
                disabled={!onGoToField}
                className={cn(
                  'focus-visible:ring-ring/60 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2',
                  onGoToField && 'hover:bg-muted/50 transition-colors duration-quick ease-out',
                )}
                data-testid={`skill-review-open-${field}`}
              >
                <span className="text-foreground font-medium">
                  {t(`editor.review.fields.${field}`)}
                </span>
                <span className="text-muted-foreground">
                  {t('editor.review.openCount', { count })}
                </span>
                {onGoToField && (
                  <ArrowRight className="text-muted-foreground ml-auto size-3.5" aria-hidden />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
