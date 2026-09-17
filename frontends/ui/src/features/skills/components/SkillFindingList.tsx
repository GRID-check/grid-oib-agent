'use client'

/**
 * What the reviewer found, as rows.
 *
 * One component, two placements, and that is deliberate: the same row renders
 * under the field a finding is about (where it is revised) and in the check
 * step's summary (where the whole verdict is read). Two renderings of one
 * finding would drift on the first severity retune, and severity here is
 * carried by an icon and a tint — the two things that drift first.
 *
 * `variant="inline"` is the copy that sits under a field: it drops the field
 * label, because the field is directly above it and naming it again is the
 * caption restating the photograph.
 */

import type { FC } from 'react'
import { AlertTriangle, Lightbulb, XCircle } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { SkillReviewFinding } from '@/adapters/api/skills-client'

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

export interface SkillFindingListProps {
  findings: readonly SkillReviewFinding[]
  /** `inline` sits under the field it is about and names no field. */
  variant?: 'inline' | 'full'
  /**
   * The draft has moved on since these were raised. They are kept on screen —
   * hiding them would lose work the author is halfway through acting on — and
   * marked, because a finding presented as current about text that has changed
   * is the one lie this surface could tell.
   */
  stale?: boolean
  className?: string
  'data-testid'?: string
}

export const SkillFindingList: FC<SkillFindingListProps> = ({
  findings,
  variant = 'full',
  stale = false,
  className,
  'data-testid': testId,
}) => {
  const t = useTranslations('skills')
  if (findings.length === 0) return null

  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-testid={testId}>
      {stale && (
        <p className="text-muted-foreground text-xs" data-testid="skill-findings-stale">
          {t('editor.review.stale')}
        </p>
      )}
      <ul
        className={cn(
          'animate-in fade-in-0 flex flex-col gap-1.5 duration-base ease-out motion-reduce:animate-none',
          stale && 'opacity-60',
        )}
      >
        {findings.map((finding, index) => {
          const Icon = SEVERITY_ICON[finding.severity]
          return (
            <li
              key={`${finding.field}-${index}`}
              className="flex items-start gap-2.5 rounded-lg border px-3 py-2"
              data-severity={finding.severity}
              data-field={finding.field}
            >
              <Icon
                className={cn('mt-px size-3.5 shrink-0', SEVERITY_TONE[finding.severity])}
                aria-hidden
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-foreground text-xs font-medium">
                  {variant === 'full' && (
                    <>
                      <span className="text-muted-foreground font-mono text-[10.5px] uppercase tracking-wider">
                        {t(`editor.review.fields.${finding.field}`)}
                      </span>{' '}
                    </>
                  )}
                  {finding.message}
                </p>
                {/* The suggested revision, as ADVICE. Never written into the
                    field for the author: it is prose („Ergänzen Sie den
                    Anlass: …"), and pasting it would put words in their skill
                    that neither they nor the reviewer wrote. */}
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
    </div>
  )
}
