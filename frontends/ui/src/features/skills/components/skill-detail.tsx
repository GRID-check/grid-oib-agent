'use client'

/**
 * The skill drawer — one skill, opened up.
 *
 * Cards answer "what is here"; the drawer answers "what is THIS": the full
 * description, the category it stands in, whether the agent reaches it, and the
 * verbatim instruction. Two authors, one drawer: an org skill offers edit and
 * delete, a curated one offers only its switch — the same actions its card
 * offers, because a drawer that could do more than the card would teach two
 * different products.
 *
 * Opened from a card or from a `?skill=` deep link (an org id, or a curated
 * name — curated skills have no id to link). The toolbox resolves the value
 * against its loaded lists; an unmatched value reads as not-found, never as
 * a drawer that never settles.
 */

import { BookOpen, Pencil, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { SkillListItem } from '@/adapters/api/skills-client'
import { agentScopeLabelKey } from '../lib/agent-scope'

interface SkillDetailProps {
  skill: SkillListItem | null
  /** The category's display name, or null when unsorted. */
  categoryName: string | null
  open: boolean
  canManage: boolean
  onEdit: (skill: SkillListItem) => void
  onToggle: (skill: SkillListItem, enabled: boolean) => void
  /** Opens the delete confirmation; the toolbox owns the dialog. */
  onDelete: (skill: SkillListItem) => void
  toggling: boolean
  onClose: () => void
}

export function SkillDetail({
  skill,
  categoryName,
  open,
  canManage,
  onEdit,
  onToggle,
  onDelete,
  toggling,
  onClose,
}: SkillDetailProps): JSX.Element {
  const t = useTranslations('skills')
  const isOrg = skill !== null && skill.id !== null
  const scopeKey = skill ? agentScopeLabelKey(skill.metadata['grid-agents']) : null

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        closeLabel={t('drawer.close')}
        data-testid="skill-detail"
        className="flex flex-col"
      >
        {skill ? (
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-2 pr-1">
            <SheetHeader>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    'text-muted-foreground font-mono text-sm font-semibold',
                    !skill.enabled && 'opacity-45',
                  )}
                >
                  /
                </span>
                {!skill.enabled && (
                  <Badge variant="outline">{t('toolbox.origin.disabled')}</Badge>
                )}
                {scopeKey && <Badge variant="outline">{t(`toolbox.scope.${scopeKey}`)}</Badge>}
              </div>
              <SheetTitle className="mt-2 text-left font-mono">{skill.name}</SheetTitle>
              <SheetDescription className="text-left">{skill.description}</SheetDescription>
            </SheetHeader>

            <section aria-label={t('drawer.detailHeading')}>
              <dl className="flex flex-col gap-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground shrink-0">{t('drawer.categoryLabel')}</dt>
                  <dd className="min-w-0 truncate text-right">{categoryName ?? t('drawer.unsorted')}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground shrink-0">{t('drawer.statusLabel')}</dt>
                  <dd className="text-right">
                    {skill.enabled ? t('drawer.statusOn') : t('drawer.statusOff')}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground shrink-0">{t('drawer.originLabel')}</dt>
                  <dd className="min-w-0 truncate text-right">
                    {skill.origin === 'platform'
                      ? t('drawer.originPlatform')
                      : skill.origin === 'platform-clone' && skill.clonedFrom
                        ? t('drawer.originClone', { name: skill.clonedFrom })
                        : t('drawer.originOrg')}
                  </dd>
                </div>
              </dl>
            </section>

            <section aria-label={t('drawer.instructionHeading')}>
              <h2 className="text-foreground text-sm font-semibold tracking-[-0.01em]">
                {t('drawer.instructionHeading')}
              </h2>
              <pre className="bg-muted text-foreground mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-xs leading-relaxed">
                {skill.body}
              </pre>
            </section>

            {canManage && (
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
                <Switch
                  checked={skill.enabled}
                  disabled={toggling}
                  onCheckedChange={(next) => onToggle(skill, next)}
                  aria-label={t('drawer.switchAria', { name: skill.name })}
                />
                {isOrg && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => onEdit(skill)}>
                      <Pencil className="size-3.5" aria-hidden />
                      {t('toolbox.actions.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => onDelete(skill)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      {t('toolbox.actions.delete')}
                    </Button>
                  </>
                )}
              </div>
            )}

            {!canManage && (
              <p className="text-muted-foreground mt-auto flex items-center gap-2 pt-2 text-xs">
                <BookOpen className="size-3.5 shrink-0" aria-hidden />
                {skill.origin === 'platform' ? t('curated.origin') : t('drawer.originOrg')}
              </p>
            )}
          </div>
        ) : (
          <div className="py-8">
            <SheetHeader>
              <SheetTitle>{t('drawer.goneTitle')}</SheetTitle>
            </SheetHeader>
            <p className="text-muted-foreground mt-2 text-sm">{t('drawer.gone')}</p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
