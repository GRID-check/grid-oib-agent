'use client'

/**
 * Platform → Skills: the fleet-wide catalogue, and where it is written.
 *
 * One row here reaches every organization at once. That is the whole point of
 * the tier, and it is what replaced the "clone a platform skill" button
 * organizations used to get: a clone copied the instruction into one tenant and
 * froze it there, so every improvement we shipped afterwards went to a skill
 * nobody was running. The body lives in this catalogue and only here.
 *
 * TWO states per row, and they are not the same question:
 *
 *   published   Whether the skill is live at all. Ours. A draft is invisible
 *               fleet-wide, which is what makes this usable as a writing
 *               surface rather than a publish-on-save wire.
 *   switched on Whether a given organization RUNS it. Theirs, on their own
 *               Skills tab. Nothing here can decide it.
 *
 * There used to be a third, `delivery`, choosing between offering a skill and
 * imposing it on the whole fleet (`standard`). It is gone with migration 0088:
 * a `standard` skill was FORCED onto every run, which is an instruction wearing
 * a capability's clothes. What the platform wants applied to every turn belongs
 * in the platform prompt; what a tenant wants applied belongs in that tenant's
 * own instruction block. Publishing a skill offers it, and an organization
 * decides.
 *
 * Publishing is still fleet-wide (every organization's Skills tab shows it at
 * once), so turning the switch ON asks first. Turning it OFF does not: a
 * withdrawal is the safe direction and is undone by the same switch.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Lock, Pencil, Plus, Sparkles, Tags, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Switch } from '@/components/ui/switch'
import { SectionCard } from '@/features/platform/components/section-card'
import { usePlatformCan } from '@/features/platform/platform-access'
import { useTranslations } from '@/i18n'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { cn } from '@/lib/utils'
import {
  createPlatformSkillCategory,
  deletePlatformSkillCategory,
  deletePlatformSkill,
  listPlatformSkillCategories,
  listPlatformSkills,
  updatePlatformSkillCategory,
  updatePlatformSkill,
  type PlatformSkillItem,
  type SkillCategoryListItem,
} from '@/adapters/api/skills-client'
import { PlatformSkillEditorDialog } from './platform-skill-editor-dialog'
import { SkillCategoryManager } from '@/features/skills/components/skill-category-manager'

export function PlatformSkillCatalog(): JSX.Element {
  const t = useTranslations('platform')
  const tSkills = useTranslations('skills')
  const canManage = usePlatformCan(PLATFORM_PERMISSIONS.settingsManage)
  const [skills, setSkills] = useState<PlatformSkillItem[] | null>(null)
  const [categories, setCategories] = useState<SkillCategoryListItem[]>([])
  /** A failed category read degrades the catalogue rather than failing it (see load). */
  const [categoriesFailed, setCategoriesFailed] = useState(false)
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<PlatformSkillItem | null>(null)
  /** Fresh mount per open — the editor seeds its fields in state initialisers. */
  const [editorKey, setEditorKey] = useState(0)
  const [pending, setPending] = useState<string[]>([])
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  /**
   * The row a deletion is pending on.
   *
   * Deleting is not the same act as unpublishing, and the two sat next to each
   * other looking identical: the switch withdraws the offer and is reversible,
   * this destroys the only copy of an authored SKILL.md. It gets a confirm
   * step and the plainer word.
   */
  const [confirmDelete, setConfirmDelete] = useState<PlatformSkillItem | null>(null)
  /** The draft a fleet-wide publish is waiting on the owner's yes for. */
  const [confirmPublish, setConfirmPublish] = useState<PlatformSkillItem | null>(null)
  const loaded = useRef(false)

  const load = useCallback(() => {
    // The first load has nothing to keep; every later one (after a save, a
    // category change, a retry) refreshes the rows in place instead of
    // dropping them for skeletons.
    if (loaded.current) setRefreshing(true)
    setCategoriesFailed(false)
    setError(false)
    // The categories are arrangement, not the catalogue: a category read that
    // fails must not hide skills that loaded fine. Skills stay fatal; without
    // categories the badges and the picker simply read unsorted, and the manager
    // button hides itself rather than opening onto an error.
    listPlatformSkills()
      .then((rows) => {
        setSkills(rows)
        loaded.current = true
        listPlatformSkillCategories()
          .then(setCategories)
          .catch(() => setCategoriesFailed(true))
      })
      .catch(() => {
        if (loaded.current) toast.error(t('skills.loadError'))
        else setError(true)
      })
      .finally(() => setRefreshing(false))
  }, [t])

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
  const setPublished = async (skill: PlatformSkillItem, published: boolean) => {
    setPending((current) => [...current, skill.id])
    setSkills(
      (prev) => prev?.map((row) => (row.id === skill.id ? { ...row, published } : row)) ?? prev
    )
    try {
      await updatePlatformSkill(skill.id, { published })
      if (published) toast.success(t('skills.published', { name: skill.name }))
    } catch {
      setSkills(
        (prev) =>
          prev?.map((row) => (row.id === skill.id ? { ...row, published: !published } : row)) ??
          prev
      )
      toast.error(t('skills.saveError'))
    } finally {
      setPending((current) => current.filter((id) => id !== skill.id))
    }
  }

  const onSwitch = (skill: PlatformSkillItem, next: boolean) => {
    if (next) setConfirmPublish(skill)
    else void setPublished(skill, false)
  }

  /** Delete, keeping the confirm open (and pending) until the server answers. */
  const remove = async (skill: PlatformSkillItem) => {
    setPending((current) => [...current, skill.id])
    try {
      await deletePlatformSkill(skill.id)
      setSkills((prev) => prev?.filter((row) => row.id !== skill.id) ?? prev)
      setConfirmDelete(null)
      toast.success(t('skills.deleted', { name: skill.name }))
    } catch {
      toast.error(t('skills.deleteError'))
    } finally {
      setPending((current) => current.filter((id) => id !== skill.id))
    }
  }

  const categoryName = useCallback(
    (id: string | null): string | null =>
      id ? (categories.find((category) => category.id === id)?.name ?? null) : null,
    [categories]
  )

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const skill of skills ?? []) {
      if (skill.categoryId) counts[skill.categoryId] = (counts[skill.categoryId] ?? 0) + 1
    }
    return counts
  }, [skills])

  const newButton = (
    <Button size="sm" onClick={() => openEditor(null)}>
      <Plus aria-hidden />
      {t('skills.new')}
    </Button>
  )

  const headerActions = canManage ? (
    <div className="flex flex-wrap items-center gap-2">
      {!categoriesFailed ? (
        <Button size="sm" variant="outline" onClick={() => setCategoriesOpen(true)}>
          <Tags aria-hidden />
          {tSkills('toolbox.categories.button')}
        </Button>
      ) : null}
      {newButton}
    </div>
  ) : undefined

  const publishedCount = skills?.filter((skill) => skill.published).length ?? 0

  return (
    <>
      <SectionCard
        title={t('skills.catalogTitle')}
        description={
          skills && skills.length > 0
            ? t('skills.catalogCount', { total: skills.length, published: publishedCount })
            : undefined
        }
        action={headerActions}
        loading={skills === null && !error}
        refreshing={refreshing}
        skeletonRows={3}
        error={error}
        errorMessage={t('skills.loadError')}
        onRetry={load}
        empty={skills !== null && skills.length === 0}
        emptyIcon={Sparkles}
        emptyTitle={t('skills.empty.title')}
        emptyDescription={t('skills.empty.description')}
        emptyAction={canManage ? newButton : undefined}
        testId="platform-skill-catalog"
      >
        {!canManage ? (
          <Alert className="mb-2">
            <Lock aria-hidden />
            <AlertDescription>{t('skills.readOnly')}</AlertDescription>
          </Alert>
        ) : null}
        <ul className="flex flex-col divide-y" data-testid="platform-skill-list">
          {(skills ?? []).map((skill) => {
            const busy = pending.includes(skill.id)
            const category = categoryName(skill.categoryId)
            return (
              <li
                key={skill.id}
                className="flex flex-col gap-3 py-4 first:pt-1 sm:flex-row sm:items-start sm:gap-6"
                data-testid={`platform-skill-${skill.name}`}
              >
                <div
                  className={cn(
                    'duration-quick min-w-0 flex-1 space-y-1 transition-opacity ease-out motion-reduce:transition-none',
                    !skill.published && 'opacity-70'
                  )}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="text-foreground min-w-0 truncate font-mono text-sm font-semibold">
                      <span aria-hidden className="text-muted-foreground">
                        /
                      </span>
                      {skill.name}
                    </p>
                    {/* The category, and only when there is one: most rows
                        start unsorted, and a badge every row carries tells
                        you nothing anyway. */}
                    {category ? <Badge variant="secondary">{category}</Badge> : null}
                  </div>
                  <p className="text-muted-foreground line-clamp-2 text-sm">{skill.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch
                    checked={skill.published}
                    disabled={busy || !canManage}
                    onCheckedChange={(next) => onSwitch(skill, next)}
                    aria-label={t('skills.publishAria', { name: skill.name })}
                  />
                  {/* The switch's state in words, so a draft is named without
                      a second badge repeating it on the title line. */}
                  <span className="text-muted-foreground ml-2 mr-2 w-24 text-xs" aria-hidden>
                    {skill.published ? t('skills.publishLabel') : t('skills.draft')}
                  </span>
                  {canManage ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEditor(skill)}
                        aria-label={t('skills.editAria', { name: skill.name })}
                      >
                        <Pencil aria-hidden />
                        {t('skills.edit')}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={busy}
                        onClick={() => setConfirmDelete(skill)}
                        aria-label={t('skills.deleteAria', { name: skill.name })}
                        title={t('skills.delete')}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      </SectionCard>

      <ConfirmDialog
        open={confirmPublish !== null}
        onOpenChange={(open) => !open && setConfirmPublish(null)}
        tone="default"
        title={t('skills.publishConfirmTitle')}
        description={t('skills.publishConfirmDescription', { name: confirmPublish?.name ?? '' })}
        confirmLabel={t('skills.publishConfirm')}
        cancelLabel={t('skills.cancel')}
        onConfirm={() => {
          const skill = confirmPublish
          setConfirmPublish(null)
          if (skill) void setPublished(skill, true)
        }}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        tone="destructive"
        title={t('skills.deleteTitle')}
        description={t('skills.deleteDescription', { name: confirmDelete?.name ?? '' })}
        confirmLabel={t('skills.deleteConfirm')}
        cancelLabel={t('skills.cancel')}
        pending={confirmDelete !== null && pending.includes(confirmDelete.id)}
        onConfirm={async () => {
          if (confirmDelete) await remove(confirmDelete)
        }}
      />

      <PlatformSkillEditorDialog
        key={editorKey}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        skill={editing}
        categories={categories}
        onSaved={() => {
          setEditorOpen(false)
          load()
        }}
      />

      <SkillCategoryManager
        open={categoriesOpen}
        onOpenChange={setCategoriesOpen}
        categories={categories}
        counts={categoryCounts}
        onCreate={async (input) => createPlatformSkillCategory(input)}
        onRename={async (id, name) => updatePlatformSkillCategory(id, { name })}
        onDelete={async (id) => deletePlatformSkillCategory(id)}
        onChanged={load}
      />
    </>
  )
}
