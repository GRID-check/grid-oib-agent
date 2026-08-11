'use client'

/**
 * Skill toolbox — the "Skill toolbox" section of the Skills tab. Renders the
 * merged toolbox (builtin platform skills + org rows, org rows shadowing same
 * names) as cards: origin + execution + schedulability badges, description,
 * a collapsible verbatim instruction preview, and actions. Builtin platform
 * skills can be cloned into the org; org-authored/cloned rows can be edited
 * and deleted (org:skills:manage — without it the section is read-only).
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, BookOpen, Copy, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { deleteSkill, listSkills, type SkillListItem } from '@/adapters/api/skills-client'
import { ConfirmDeleteDialog } from './confirm-delete-dialog'

interface SkillToolboxProps {
  /** Whether this member may author/clone/edit/delete skills (org:skills:manage). */
  canManage: boolean
  /** Open the editor to clone a builtin platform skill. */
  onClone: (skill: SkillListItem) => void
  /** Open the editor for an org row (edit, or create empty from scratch). */
  onEdit: (skill: SkillListItem | null) => void
}

function originBadge(
  t: ReturnType<typeof useTranslations>,
  skill: SkillListItem,
): JSX.Element | null {
  if (skill.origin === 'platform') return <Badge variant="secondary">{t('toolbox.origin.platform')}</Badge>
  if (skill.origin === 'platform-clone') return <Badge variant="secondary">{t('toolbox.origin.cloned')}</Badge>
  return <Badge variant="outline">{t('toolbox.origin.org')}</Badge>
}

export function SkillToolbox({
  canManage,
  onClone,
  onEdit,
}: SkillToolboxProps): JSX.Element {
  const t = useTranslations('skills')
  const [skills, setSkills] = useState<SkillListItem[] | null>(null)
  const [error, setError] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const load = useCallback(() => {
    setSkills(null)
    setError(false)
    listSkills()
      .then(setSkills)
      .catch(() => setError(true))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const confirmDelete = async () => {
    if (!confirmId) return
    setDeletingId(confirmId)
    try {
      await deleteSkill(confirmId)
      setConfirmId(null)
      setSkills((prev) => prev?.filter((skill) => skill.id !== confirmId) ?? prev)
    } catch {
      toast.error(t('editor.saveError'))
    } finally {
      setDeletingId(null)
    }
  }

  // A null confirmId means no deletion is pending — never match it against a
  // platform skill (whose id is also null).
  const confirmation = confirmId ? (skills?.find((skill) => skill.id === confirmId) ?? null) : null

  return (
    <section className="space-y-4" aria-labelledby="skill-toolbox-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 id="skill-toolbox-heading" className="text-sm font-semibold text-foreground">
            {t('toolbox.heading')}
          </h2>
          <p className="max-w-3xl text-xs text-muted-foreground">{t('toolbox.hint')}</p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => onEdit(null)}>
            <Plus className="size-4" aria-hidden />
            {t('toolbox.newSkill')}
          </Button>
        )}
      </div>

      {skills === null && !error && (
        <div className="space-y-3" data-testid="skills-toolbox-loading">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t('toolbox.loadError')}</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={load}>
              {t('tryAgain')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {skills !== null && !error && skills.length === 0 && (
        <EmptyState
          icon={Sparkles}
          title={t('toolbox.empty.title')}
          description={t('toolbox.empty.description')}
          action={
            canManage ? (
              <Button onClick={() => onEdit(null)}>
                <Plus className="size-4" aria-hidden />
                {t('toolbox.empty.action')}
              </Button>
            ) : undefined
          }
        />
      )}

      {skills !== null && !error && skills.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {skills.map((skill) => (
            <Card key={skill.name}>
              <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <h3 className="truncate font-mono text-sm font-semibold text-foreground">
                      {skill.name}
                    </h3>
                    <p className="line-clamp-2 text-sm text-muted-foreground">{skill.description}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {originBadge(t, skill)}
                    <Badge
                      variant="outline"
                      title={skill.metadata['grid-execution'] === 'deep-research' ? '' : undefined}
                    >
                      {skill.metadata['grid-execution'] === 'deep-research'
                        ? t('toolbox.execution.deepResearch')
                        : t('toolbox.execution.chat')}
                    </Badge>
                    {skill.metadata['grid-schedulable'] !== 'false' ? (
                      <Badge variant="outline">{t('toolbox.schedulable')}</Badge>
                    ) : (
                      <Badge variant="secondary">{t('toolbox.notSchedulable')}</Badge>
                    )}
                  </div>
                </div>

                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground">
                      <BookOpen className="size-3.5" aria-hidden />
                      {t('toolbox.actions.viewBody')}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="border-t border-border pt-2">
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground">
                      {skill.body}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>

                {canManage && (
                  <div className="flex flex-wrap items-center gap-2">
                    {skill.origin === 'platform' ? (
                      <Button
                        size="sm"
                        onClick={() => onClone(skill)}
                        aria-label={t('toolbox.actions.cloneAria', { name: skill.name })}
                      >
                        <Copy className="size-3.5" aria-hidden />
                        {t('toolbox.actions.clone')}
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onEdit(skill)}
                          disabled={deletingId === skill.id}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                          {t('toolbox.actions.edit')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setConfirmId(skill.id!)}
                          disabled={deletingId === skill.id}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                          {t('toolbox.actions.delete')}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDeleteDialog
        open={confirmation !== null}
        onOpenChange={(open) => !open && setConfirmId(null)}
        title={t('editor.deleteTitle')}
        description={t('editor.deleteDescription', { name: confirmation?.name ?? '' })}
        confirmLabel={t('editor.deleteConfirm')}
        cancelLabel={t('editor.cancel')}
        pending={deletingId !== null}
        onConfirm={confirmDelete}
      />
    </section>
  )
}