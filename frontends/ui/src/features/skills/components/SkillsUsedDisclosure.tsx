'use client'

/**
 * "Skills used" — what the agent actually LOADED while writing this answer.
 *
 * The distinction this component exists to make visible: every skill in the org
 * contributes its name and description to the agent's catalogue on every turn
 * (progressive disclosure level 1, ~a line each), but a skill's full
 * instructions enter the conversation only when the agent decides to load them
 * with `use_skill`. Those decisions are what `skills_activated` reports, and
 * they are the ones worth showing — "this skill was available" is not news,
 * "this skill's instructions shaped this answer" is.
 *
 * Quiet by default for the same reason the confidence chip is: on a normal turn
 * nothing was activated and this renders nothing at all. When something was, a
 * single muted line says so, and opening it shows which skills and what they
 * are for.
 *
 * Descriptions are fetched only on expand. The names arrive on the answer
 * frame; the descriptions are a separate org-scoped read, and paying for it on
 * every rendered answer to fill a panel almost nobody opens would be exactly the
 * eager loading the skills model is designed to avoid.
 */

import { useState, type FC } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { useInvocableSkills } from '../hooks/use-invocable-skills'
import { skillLabel } from '../lib/skill-activity'

export interface SkillsUsedDisclosureProps {
  /** Skill names the agent activated, in activation order. */
  skillsActivated?: string[]
  className?: string
}

export const SkillsUsedDisclosure: FC<SkillsUsedDisclosureProps> = ({
  skillsActivated,
  className,
}) => {
  const t = useTranslations('skills')
  const [open, setOpen] = useState(false)
  const { skills } = useInvocableSkills(open)

  if (!skillsActivated || skillsActivated.length === 0) return null

  const count = skillsActivated.length
  const summary = count === 1 ? t('composer.activated.one') : t('composer.activated.other', { count })

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('mt-1.5', className)}>
      <CollapsibleTrigger
        className={cn(
          'text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 flex items-center gap-1.5',
          'rounded-md text-[11px] leading-relaxed transition-colors duration-200 ease-out',
          'focus-visible:outline-none focus-visible:ring-2',
        )}
        data-testid="skills-used-trigger"
      >
        <Sparkles className="size-3 shrink-0" aria-hidden />
        <span>{summary}</span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-1.5">
        <div
          className="border-border/70 bg-muted/30 animate-in fade-in-0 flex flex-col gap-2 rounded-lg border px-3 py-2.5 duration-200 ease-out motion-reduce:animate-none"
          data-testid="skills-used-panel"
        >
          <p className="text-foreground text-[11px] font-medium">{t('composer.activated.title')}</p>

          <ul className="flex flex-col gap-1.5">
            {skillsActivated.map((name) => {
              const known = skills.find((skill) => skill.name === name)
              // The ONE naming rule, shared with the live header line and the
              // Herleitung chip (features/skills/lib/skill-activity): an
              // authored title in proportional text, otherwise the bare
              // identifier in `font-mono` — which is what this panel has always
              // rendered, so nothing changes until titles exist. A row that
              // cannot name its skill is dropped rather than shown blank.
              const label = skillLabel({ name })
              if (!label) return null
              return (
                <li key={name} className="flex flex-col gap-0.5">
                  <span
                    className={cn('text-foreground text-[11px]', label.mono && 'font-mono')}
                  >
                    {label.text}
                  </span>
                  {/* Absent when the descriptions have not arrived yet, or when
                      the skill has since been deleted or renamed. The name alone
                      is still true, so the row stays rather than disappearing. */}
                  <span className="text-muted-foreground line-clamp-2 min-h-[1.375rem] text-[11px] leading-snug">
                    {known?.description ?? ''}
                  </span>
                </li>
              )
            })}
          </ul>

          {/* The mechanism, stated once at the bottom: it is the same for every
              answer, so it belongs under the specifics rather than above them. */}
          <p className="text-muted-foreground/80 text-[11px] leading-snug">
            {t('composer.activated.explainer')}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
