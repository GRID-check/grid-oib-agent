'use client'

/**
 * The reviewer's opinion of the skill being written.
 *
 * Why this is a model and not a linter: the question that actually decides
 * whether a skill works is "will this description match the requests people
 * make?", and that is a question about meaning. A regex can check that a
 * description is non-empty and under 1024 characters — which the save already
 * enforces — but not that it is specific enough to be selected over every other
 * skill in the org. So the check is the same kind of thing it is checking.
 *
 * Advisory, never blocking. Findings appear beside the form; the save is
 * unaffected by them, and a review that fails to run says so rather than
 * quietly reporting a clean bill of health. Reviewing a draft is also not a
 * privileged action — the same panel appears for anyone who can open the
 * editor, because the person most likely to write a description that never
 * matches anything is the person writing their first skill.
 */

import { useCallback, useState, type FC } from 'react'
import { AlertTriangle, Check, Lightbulb, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { reviewSkill, type SkillReviewFinding } from '@/adapters/api/skills-client'

export interface SkillReviewPanelProps {
  name: string
  description: string
  body: string
  className?: string
}

const SEVERITY_ORDER: Record<SkillReviewFinding['severity'], number> = {
  error: 0,
  warning: 1,
  suggestion: 2,
}

const SEVERITY_ICON = {
  error: XCircle,
  warning: AlertTriangle,
  suggestion: Lightbulb,
} as const

const SEVERITY_TONE = {
  error: 'text-destructive',
  warning: 'text-warning-foreground',
  suggestion: 'text-muted-foreground',
} as const

type ReviewState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; findings: SkillReviewFinding[] }
  | { kind: 'unavailable' }

export const SkillReviewPanel: FC<SkillReviewPanelProps> = ({
  name,
  description,
  body,
  className,
}) => {
  const t = useTranslations('skills')
  const [state, setState] = useState<ReviewState>({ kind: 'idle' })

  const run = useCallback(async () => {
    setState({ kind: 'running' })
    const { findings } = await reviewSkill({ name, description, body })
    // `null` is "could not check", NOT "nothing wrong". Saying "looks good"
    // here would be the one failure mode this panel must never have.
    setState(findings ? { kind: 'done', findings } : { kind: 'unavailable' })
  }, [body, description, name])

  const sorted =
    state.kind === 'done'
      ? [...state.findings].sort(
          (left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity],
        )
      : []

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
          variant="outline"
          size="sm"
          onClick={() => void run()}
          disabled={state.kind === 'running'}
          aria-busy={state.kind === 'running'}
          className="h-8 px-3.5 text-xs"
        >
          <span className="inline-grid justify-items-start">
            <span
              className={cn(
                'col-start-1 row-start-1 inline-flex items-center gap-1.5',
                state.kind === 'running' && 'invisible',
              )}
              aria-hidden={state.kind === 'running'}
            >
              {t('editor.review.action')}
            </span>
            <span
              className={cn(
                'col-start-1 row-start-1 inline-flex items-center gap-1.5',
                state.kind !== 'running' && 'invisible',
              )}
              aria-hidden={state.kind !== 'running'}
            >
              <Spinner size="sm" aria-hidden />
              {t('editor.review.running')}
            </span>
          </span>
        </Button>
      </div>

      <p className="text-muted-foreground text-xs">{t('editor.review.subtitle')}</p>

      {state.kind === 'unavailable' && (
        <p
          className="text-muted-foreground animate-in fade-in-0 rounded-lg border border-dashed px-3 py-2 text-xs duration-base ease-out motion-reduce:animate-none"
          role="status"
        >
          {/* Explicitly NOT "looks good": the reviewer never ran. */}
          {t('editor.review.unavailable')}
        </p>
      )}

      {state.kind === 'done' && sorted.length === 0 && (
        <p
          className="text-muted-foreground animate-in fade-in-0 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs duration-base ease-out motion-reduce:animate-none"
          role="status"
        >
          <Check className="size-3.5 shrink-0 text-success-foreground" aria-hidden />
          {t('editor.review.clean')}
        </p>
      )}

      {state.kind === 'done' && sorted.length > 0 && (
        <ul
          className="animate-in fade-in-0 flex flex-col gap-1.5 duration-base ease-out motion-reduce:animate-none"
          data-testid="skill-review-findings"
        >
          {sorted.map((finding, index) => {
            const Icon = SEVERITY_ICON[finding.severity]
            return (
              <li
                key={`${finding.field}-${index}`}
                className="flex items-start gap-2.5 rounded-lg border px-3 py-2"
              >
                <Icon
                  className={cn('mt-px size-3.5 shrink-0', SEVERITY_TONE[finding.severity])}
                  aria-hidden
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="text-foreground text-xs font-medium">
                    <span className="text-muted-foreground font-mono text-[10.5px] uppercase tracking-wider">
                      {t(`editor.review.fields.${finding.field}`)}
                    </span>{' '}
                    {finding.message}
                  </p>
                  {finding.fix && (
                    <p className="text-muted-foreground text-xs leading-snug">{finding.fix}</p>
                  )}
                  {/* The rule that produced this, quietly. It is what turns a
                      complaint into a citation — an author who disagrees can go
                      read the rule instead of arguing with a verdict. Muted and
                      last, because it is provenance, not the point. */}
                  {finding.check && (
                    <p className="text-muted-foreground/70 font-mono text-xs leading-snug">
                      {finding.check}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
