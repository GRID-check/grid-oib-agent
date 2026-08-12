'use client'

/**
 * Featured skills: what Piloti curates for every organization, at the TOP of
 * the Skills tab.
 *
 * These are written once in Platform → Skills and offered to the whole fleet,
 * and they are the point of the page rather than an appendix to it — an
 * organization gets more out of switching one of ours on than out of writing
 * its first one from a blank editor. So they lead, as cards, above the org's
 * own; the first draft of this buried them behind a chevron, which was the same
 * misjudgement in the other direction as the one that put the pipeline's
 * machinery in the main grid.
 *
 * The action is a switch, not a copy. Cloning a platform skill produced a
 * second skill frozen at the moment it was copied: an org ended up maintaining
 * an instruction it never wrote, and every improvement we shipped afterwards
 * went to a skill it was no longer using. Switching one on keeps a single
 * living copy — ours — and an org that turns it off is back where it started.
 *
 * The pipeline's own machinery never reaches this component. It is not curated,
 * so the server does not list it and would 404 any attempt to switch it (see
 * `lib/skills/service.ts`): how deep research writes its report is not an
 * organization's decision, and it is not shown as though it were.
 */

import { useState } from 'react'
import { BookOpen, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { setCuratedSkillEnabled, type SkillListItem } from '@/adapters/api/skills-client'
import { agentScopeLabelKey } from '../lib/agent-scope'

interface CuratedSkillsProps {
  skills: SkillListItem[]
  /** Whether this member may switch one on (org:skills:manage). */
  canManage: boolean
  /** Reflect the new state in the list the toolbox holds. */
  onToggled: (name: string, enabled: boolean) => void
}

export function CuratedSkills({
  skills,
  canManage,
  onToggled,
}: CuratedSkillsProps): JSX.Element | null {
  const t = useTranslations('skills')
  /** Names mid-flight, so a switch cannot be flipped twice. */
  const [pending, setPending] = useState<string[]>([])
  if (skills.length === 0) return null

  const activeCount = skills.filter((skill) => skill.enabled).length

  /**
   * Optimistic, reverted on failure. A switch that waits for a round trip
   * before it moves is a switch you press twice — and this one is cheap to
   * undo, which is exactly the case optimism is for.
   */
  const toggle = async (skill: SkillListItem, enabled: boolean) => {
    setPending((current) => [...current, skill.name])
    onToggled(skill.name, enabled)
    try {
      await setCuratedSkillEnabled(skill.name, enabled)
    } catch {
      onToggled(skill.name, !enabled)
      toast.error(t('editor.saveError'))
    } finally {
      setPending((current) => current.filter((name) => name !== skill.name))
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="featured-skills-heading">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          id="featured-skills-heading"
          className="text-foreground text-sm font-semibold tracking-[-0.01em]"
        >
          {t('curated.heading')}
        </h2>
        {/* The count that carries information is how many are ON, not how many
            exist — "2 of 6" tells you where you stand; "6" is furniture. */}
        <span className="text-muted-foreground text-xs tabular-nums">
          {t('curated.count', { active: activeCount, total: skills.length })}
        </span>
      </div>
      <p className="text-muted-foreground max-w-3xl text-xs leading-relaxed">
        {t('curated.hint')}
      </p>

      <div className="mt-1 grid gap-4 lg:grid-cols-2">
        {skills.map((skill) => (
          // The same card as an org skill, on purpose: a curated skill is not a
          // lesser thing to be listed, it is the same kind of object with a
          // different author. What distinguishes it is the tray's one word.
          <RaisedCard key={skill.name}>
            <RaisedCardBody className="flex flex-1 flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div
                  className={cn(
                    'min-w-0 space-y-1 transition-opacity duration-200 motion-reduce:transition-none',
                    !skill.enabled && 'opacity-50',
                  )}
                >
                  <h3 className="text-foreground truncate font-mono text-sm font-semibold">
                    <span aria-hidden className="text-muted-foreground">
                      /
                    </span>
                    {skill.name}
                  </h3>
                  <p className="text-muted-foreground line-clamp-2 text-sm">{skill.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* Same rule as an org card: a scope badge only where the
                      skill does NOT reach every agent. */}
                  {agentScopeLabelKey(skill.metadata['grid-agents']) && (
                    <Badge variant="outline">
                      {t(`toolbox.scope.${agentScopeLabelKey(skill.metadata['grid-agents'])}`)}
                    </Badge>
                  )}
                  {canManage && (
                    <Switch
                      checked={skill.enabled}
                      disabled={pending.includes(skill.name)}
                      onCheckedChange={(next) => void toggle(skill, next)}
                      aria-label={t('curated.actions.enabledAria', { name: skill.name })}
                    />
                  )}
                </div>
              </div>
            </RaisedCardBody>

            <RaisedCardFooter>
              <Collapsible className="w-full">
                <div className="flex w-full items-center gap-2">
                  {/* Provenance, always, and only here: on this half of the page
                      it is the thing that distinguishes a card — somebody else
                      wrote and maintains this one. */}
                  <span className="min-w-0 truncate">{t('curated.origin')}</span>
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground group -my-1 ml-auto h-7 shrink-0 px-2"
                    >
                      <BookOpen className="size-3.5" aria-hidden />
                      {t('toolbox.actions.viewBody')}
                      <ChevronDown
                        className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
                        aria-hidden
                      />
                    </Button>
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent className="pt-2">
                  <pre className="bg-muted/40 text-foreground max-h-64 overflow-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-xs leading-relaxed">
                    {skill.body}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            </RaisedCardFooter>
          </RaisedCard>
        ))}
      </div>
    </section>
  )
}
