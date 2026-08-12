'use client'

/**
 * The platform-curated skills, folded away at the foot of the Skills tab.
 *
 * These are skills Piloti publishes to every organization. They are not the
 * page — the page is what this organization wrote — so they sit under one line
 * of text and a chevron, opened on demand, presented as a plain divided list
 * rather than as cards. The difference in surface IS the statement about which
 * of the two matters here.
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
import { BookOpen, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
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
    <Collapsible className="border-border/60 mt-10 border-t pt-4">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2"
        >
          <ChevronRight
            className="size-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          <span className="font-medium">{t('curated.heading')}</span>
          {/* The count that carries information is how many are ON, not how
              many exist — "2 of 6" tells you where you stand; "6" is furniture. */}
          <span className="tabular-nums opacity-60">
            {t('curated.count', { active: activeCount, total: skills.length })}
          </span>
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <p className="text-muted-foreground mt-2 max-w-3xl text-xs leading-relaxed">
          {t('curated.hint')}
        </p>

        <ul className="border-border/60 divide-border/60 mt-4 divide-y rounded-xl border">
          {skills.map((skill) => (
            <li key={skill.name}>
              {/* One collapsible per row: the instruction is the only thing to
                  show, and it opens where it belongs rather than in a dialog
                  that would imply something here is editable. */}
              <Collapsible className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div
                    className={cn(
                      'min-w-0 space-y-1 transition-opacity duration-200 motion-reduce:transition-none',
                      !skill.enabled && 'opacity-55',
                    )}
                  >
                    <p className="text-foreground truncate font-mono text-sm">
                      <span aria-hidden className="text-muted-foreground">
                        /
                      </span>
                      {skill.name}
                    </p>
                    <p className="text-muted-foreground line-clamp-2 text-sm">
                      {skill.description}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* Same rule as a skill card: a scope badge only where the
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

                <div className="-mx-2 mt-2">
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground group h-7 px-2"
                    >
                      <BookOpen className="size-3.5" aria-hidden />
                      {t('toolbox.actions.viewBody')}
                      <ChevronRight
                        className="size-3.5 transition-transform duration-200 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
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
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
