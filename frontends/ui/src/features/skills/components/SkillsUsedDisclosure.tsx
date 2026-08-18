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
 *
 * HIDDEN skills (`grid-hidden`) are treated with care here, because this panel
 * is the RECORD. A hidden skill is kept out of the noisy LIVE line, but the
 * disclosure is not the live line — it is the honest answer to "what shaped
 * this answer". So a hidden skill is NEVER dropped from it: doctrine is that a
 * product built on traceable sourcing must not have a class of instruction it
 * declines to admit ran. It is merely DE-EMPHASISED (muted) until the reader
 * turns the reasoning view on (`showReasoning`), at which point it reads at full
 * weight with everything else. Hidden governs the live line, not this record.
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
  /**
   * The subset of `skillsActivated` that are HIDDEN (`grid-hidden`) — kept out
   * of the live line, but never out of this record. Populated by the caller
   * from the streamed technical-channel activations. Absent = none hidden, so
   * an existing caller renders exactly as before.
   */
  hiddenSkills?: string[]
  /**
   * The reader's reasoning-view preference (`showReasoningSkills`). When true,
   * hidden skills read at full weight alongside the rest; when false they are
   * present but de-emphasised. Either way they are shown — the toggle changes
   * emphasis, never presence.
   */
  showReasoning?: boolean
  className?: string
}

export const SkillsUsedDisclosure: FC<SkillsUsedDisclosureProps> = ({
  skillsActivated,
  hiddenSkills,
  showReasoning = false,
  className,
}) => {
  const t = useTranslations('skills')
  const [open, setOpen] = useState(false)
  const { skills } = useInvocableSkills(open)

  if (!skillsActivated || skillsActivated.length === 0) return null

  const hiddenSet = new Set(hiddenSkills ?? [])
  const count = skillsActivated.length
  const summary = count === 1 ? t('composer.activated.one') : t('composer.activated.other', { count })

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('mt-1.5', className)}>
      <CollapsibleTrigger
        className={cn(
          'text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 flex items-center gap-1.5',
          'rounded-md text-xs leading-relaxed transition-colors duration-quick ease-out',
          'focus-visible:outline-none focus-visible:ring-2',
        )}
        data-testid="skills-used-trigger"
      >
        <Sparkles className="size-3 shrink-0" aria-hidden />
        <span>{summary}</span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-1.5">
        <div
          className="bg-muted animate-in fade-in-0 flex flex-col gap-2 rounded-lg border px-3 py-2.5 duration-base ease-out motion-reduce:animate-none"
          data-testid="skills-used-panel"
        >
          <p className="text-foreground text-xs font-medium">{t('composer.activated.title')}</p>

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
              // A hidden skill stays in the record; it is only muted until the
              // reasoning view is on. Never `return null` for one — dropping it
              // would be the one thing the transparency doctrine forbids.
              const hidden = hiddenSet.has(name)
              const deEmphasised = hidden && !showReasoning
              return (
                <li
                  key={name}
                  className={cn(
                    'flex flex-col gap-0.5 transition-opacity duration-quick ease-out',
                    deEmphasised && 'opacity-60',
                  )}
                  data-hidden={hidden ? 'true' : undefined}
                  data-testid={hidden ? 'skills-used-hidden-row' : undefined}
                >
                  <span
                    className={cn('text-foreground text-xs', label.mono && 'font-mono')}
                  >
                    {label.text}
                  </span>
                  {/* Absent when the descriptions have not arrived yet, or when
                      the skill has since been deleted or renamed. The name alone
                      is still true, so the row stays rather than disappearing. */}
                  <span className="text-muted-foreground line-clamp-2 min-h-[1.375rem] text-xs leading-snug">
                    {known?.description ?? ''}
                  </span>
                </li>
              )
            })}
          </ul>

          {/* The mechanism, stated once at the bottom: it is the same for every
              answer, so it belongs under the specifics rather than above them. */}
          <p className="text-muted-foreground/80 text-xs leading-snug">
            {t('composer.activated.explainer')}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
