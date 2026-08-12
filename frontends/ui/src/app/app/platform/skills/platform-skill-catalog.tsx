'use client'

/**
 * Platform → Skills: the curated catalogue, and where it is written.
 *
 * One row here is offered to every organization at once. That is the whole
 * point of the tier, and it is what replaced the "clone a platform skill"
 * button organizations used to get: a clone copied the instruction into one
 * tenant and froze it there, so every improvement we shipped afterwards went to
 * a skill nobody was running. The body lives in this catalogue and only here.
 *
 * Two states per row, and they are not the same question:
 *
 *   published   Whether organizations can SEE it. Ours. A draft is invisible
 *               fleet-wide, which is what makes this usable as a writing
 *               surface rather than a publish-on-save wire.
 *   switched on Whether a given organization RUNS it. Theirs, on their own
 *               Skills tab. Nothing here can decide it — publishing offers, it
 *               does not impose.
 *
 * The editor is the org authoring dialog (`SkillEditorDialog`) deliberately: a
 * curated skill is not a privileged shape, it is the same SKILL.md document
 * written one tier up, and it deserves the same live preview, the same reviewer
 * and the same raw-document escape hatch.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Plus, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDeleteDialog } from '@/features/skills/components/confirm-delete-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  deletePlatformSkill,
  listPlatformSkills,
  updatePlatformSkill,
  type PlatformSkillItem,
} from '@/adapters/api/skills-client'
import { PlatformSkillEditorDialog } from './platform-skill-editor-dialog'

export function PlatformSkillCatalog(): JSX.Element {
  const t = useTranslations('platform')
  const [skills, setSkills] = useState<PlatformSkillItem[] | null>(null)
  const [error, setError] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<PlatformSkillItem | null>(null)
  /** Fresh mount per open — the editor seeds its fields in state initialisers. */
  const [editorKey, setEditorKey] = useState(0)
  const [pending, setPending] = useState<string[]>([])
  /**
   * The row a deletion is pending on.
   *
   * Deleting is not the same act as unpublishing, and the two sat next to each
   * other looking identical: the switch withdraws the offer and is reversible,
   * this destroys the only copy of an authored SKILL.md. It gets a confirm
   * step and the plainer word.
   */
  const [confirmDelete, setConfirmDelete] = useState<PlatformSkillItem | null>(null)

  const load = useCallback(() => {
    setSkills(null)
    setError(false)
    listPlatformSkills()
      .then(setSkills)
      .catch(() => setError(true))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openEditor = (skill: PlatformSkillItem | null) => {
    setEditing(skill)
    setEditorKey((key) => key + 1)
    setEditorOpen(true)
  }

  /**
   * Publish or withdraw. Optimistic and reverted on failure — the same
   * treatment the org-side switch gets, for the same reason: it is cheap to
   * undo, and a control that waits for a round trip is one you press twice.
   */
  const togglePublished = async (skill: PlatformSkillItem, published: boolean) => {
    setPending((current) => [...current, skill.id])
    setSkills((prev) => prev?.map((row) => (row.id === skill.id ? { ...row, published } : row)) ?? prev)
    try {
      await updatePlatformSkill(skill.id, { published })
    } catch {
      setSkills(
        (prev) =>
          prev?.map((row) => (row.id === skill.id ? { ...row, published: !published } : row)) ?? prev,
      )
      toast.error(t('skills.saveError'))
    } finally {
      setPending((current) => current.filter((id) => id !== skill.id))
    }
  }

  const remove = async (skill: PlatformSkillItem) => {
    setConfirmDelete(null)
    setPending((current) => [...current, skill.id])
    try {
      await deletePlatformSkill(skill.id)
      setSkills((prev) => prev?.filter((row) => row.id !== skill.id) ?? prev)
      toast.success(t('skills.deleted', { name: skill.name }))
    } catch {
      toast.error(t('skills.saveError'))
    } finally {
      setPending((current) => current.filter((id) => id !== skill.id))
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-3xl text-sm">{t('skills.hint')}</p>
        <Button size="sm" onClick={() => openEditor(null)}>
          <Plus className="size-4" aria-hidden />
          {t('skills.new')}
        </Button>
      </div>

      {skills === null && !error && (
        <div className="flex flex-col gap-3" data-testid="platform-skills-loading">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t('skills.loadError')}</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={load}>
              {t('skills.tryAgain')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {skills !== null && !error && skills.length === 0 && (
        <EmptyState
          icon={Sparkles}
          title={t('skills.empty.title')}
          description={t('skills.empty.description')}
          action={
            <Button onClick={() => openEditor(null)}>
              <Plus className="size-4" aria-hidden />
              {t('skills.new')}
            </Button>
          }
        />
      )}

      {skills !== null && !error && skills.length > 0 && (
        <ul className="flex flex-col gap-3">
          {skills.map((skill) => (
            <li key={skill.id}>
              <Card>
                <CardContent className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div
                      className={cn(
                        'min-w-0 space-y-1 transition-opacity duration-200 motion-reduce:transition-none',
                        !skill.published && 'opacity-60',
                      )}
                    >
                      <p className="text-foreground truncate font-mono text-sm font-semibold">
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
                      {/* Said only while it is true. A "Published" badge on the
                          published ones would repeat the switch beside it; a
                          draft is the state worth naming, because it is the one
                          where nobody else can see what you are looking at. */}
                      {!skill.published && <Badge variant="outline">{t('skills.draft')}</Badge>}
                      <Switch
                        checked={skill.published}
                        disabled={pending.includes(skill.id)}
                        onCheckedChange={(next) => void togglePublished(skill, next)}
                        aria-label={t('skills.publishAria', { name: skill.name })}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => openEditor(skill)}>
                      {t('skills.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={pending.includes(skill.id)}
                      onClick={() => setConfirmDelete(skill)}
                    >
                      {t('skills.delete')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDeleteDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={t('skills.deleteTitle')}
        description={t('skills.deleteDescription', { name: confirmDelete?.name ?? '' })}
        confirmLabel={t('skills.deleteConfirm')}
        cancelLabel={t('skills.cancel')}
        pending={confirmDelete !== null && pending.includes(confirmDelete.id)}
        onConfirm={() => {
          if (confirmDelete) void remove(confirmDelete)
        }}
      />

      <PlatformSkillEditorDialog
        key={editorKey}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        skill={editing}
        onSaved={() => {
          setEditorOpen(false)
          load()
        }}
      />
    </section>
  )
}
