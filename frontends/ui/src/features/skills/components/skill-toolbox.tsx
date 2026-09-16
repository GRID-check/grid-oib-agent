'use client'

/**
 * The Skills tab's content: the skills Piloti curates for every organization
 * (`curated-skills.tsx`), and then the ones this one wrote itself — each half
 * grouped onto categories, with the unsorted closers last.
 *
 * Featured leads. An organization gets more out of switching one of ours on
 * than out of writing its first skill from a blank editor, so the curated set
 * is the top of the page rather than an appendix to it.
 *
 * The pipeline's own machinery used to sit in this same grid as equal cards,
 * each offering a "clone". Both were wrong. Those are hardcoded files, not
 * rows: nobody installs one, nobody can edit one, and every one of them
 * declares `grid-agents: deep_researcher`, so none is even invocable from chat
 * — they are how deep research analyses figures and writes its report. Five of
 * them in front of an org with two skills of its own made the page look like it
 * was mostly ours, and the one action they offered produced a frozen copy of an
 * instruction the org never wrote. They are gone from this surface entirely
 * (see `lib/skills/service.ts::listSkills`) and still resolve for every run.
 *
 * What replaces clone is a switch, in both halves of the page. A skill is
 * either in play for this organization or it is not, and that is the only state
 * anyone here has an opinion about: for an org's own skill it is
 * `skills.enabled`, which already gated resolution but sat three clicks deep in
 * the editor; for a curated one it is the org's activation decision.
 *
 * A card opens its drawer, and a `?skill=` deep link opens it directly — an
 * org id, or a curated name. Authoring is gated on org:skills:manage; without
 * it the page is read-only. Nothing here is about time or output: a skill
 * says neither.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, BookOpen, ChevronDown, Library, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { SearchField } from '@/components/ui/search-field'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  createSkillCategory,
  deleteSkill,
  deleteSkillCategory,
  listSkills,
  updateSkill,
  updateSkillCategory,
  type SkillCategoryListItem,
  type SkillListItem,
} from '@/adapters/api/skills-client'
import { agentScopeLabelKey } from '../lib/agent-scope'
import { groupSkillsByCategory, matchesSkillQuery, type CategoryGroup } from '../lib/skill-categories'
import { CuratedSkills } from './curated-skills'
import { SkillDetail } from './skill-detail'
import { SkillCategoryManager } from './skill-category-manager'
import { capturePosthog } from '@/lib/analytics/posthog'

interface SkillToolboxProps {
  /** Whether this member may author/edit/delete skills (org:skills:manage). */
  canManage: boolean
  /** Open the editor for a skill (edit, or create empty from scratch). */
  onEdit: (skill: SkillListItem | null) => void
  /**
   * Bumped by the panel after a save, to re-fetch.
   *
   * Without it a skill you had just written did not appear until a reload —
   * the save succeeded, the toast said so, and the page still showed the list
   * from before it, which reads as the save having done nothing.
   */
  reloadKey?: number
  /** Categories changed outside (editor save) — re-fetch above. */
  onCategoriesChanged?: () => void
}

/** The `?skill=` on the URL, if any — an org id, or a curated name. */
function readSelectionFromUrl(): string | null {
  try {
    if (typeof window === 'undefined') return null
    return new URL(window.location.href).searchParams.get('skill')
  } catch {
    return null
  }
}

/** Keep the deep link on the URL while the drawer is open, drop it on close. */
function syncSelectionToUrl(value: string | null): void {
  try {
    const url = new URL(window.location.href)
    url.searchParams.delete('skill')
    if (value) url.searchParams.set('skill', value)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // History unavailable (embedded preview) — the drawer still works.
  }
}

export function SkillToolbox({
  canManage,
  onEdit,
  reloadKey = 0,
  onCategoriesChanged,
}: SkillToolboxProps): JSX.Element {
  const t = useTranslations('skills')
  const [skills, setSkills] = useState<SkillListItem[] | null>(null)
  const [categories, setCategories] = useState<SkillCategoryListItem[]>([])
  const [error, setError] = useState(false)
  const [query, setQuery] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  /** Ids whose switch is mid-flight, so it cannot be flipped twice. */
  const [togglingIds, setTogglingIds] = useState<string[]>([])
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(() => readSelectionFromUrl())

  const load = useCallback(() => {
    setSkills(null)
    setError(false)
    listSkills()
      .then(({ skills: rows, categories: categories }) => {
        setSkills(rows)
        setCategories(categories)
      })
      .catch(() => setError(true))
  }, [])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  const confirmDelete = async () => {
    if (!confirmId) return
    setDeletingId(confirmId)
    try {
      await deleteSkill(confirmId)
      capturePosthog('skill_deleted', { scope: 'organization' })
      setConfirmId(null)
      setSelected((current) => {
        const doomed = skills?.find((skill) => skill.id === confirmId)
        return current && doomed && selectionKey(doomed) === current ? null : current
      })
      setSkills((prev) => prev?.filter((skill) => skill.id !== confirmId) ?? prev)
    } catch {
      toast.error(t('editor.saveError'))
    } finally {
      setDeletingId(null)
    }
  }

  /**
   * Flip a skill on or off — an org row by id, a curated offer by name.
   *
   * Optimistic, and reverted on failure. A switch that waits for a round trip
   * before moving is a switch you press twice — and this one is cheap to undo,
   * which is exactly the case optimism is for.
   */
  const toggleEnabled = async (skill: SkillListItem, enabled: boolean) => {
    const key = selectionKey(skill)
    setTogglingIds((current) => [...current, key])
    setSkills(
      (prev) =>
        prev?.map((row) => (selectionKey(row) === key ? { ...row, enabled } : row)) ?? prev,
    )
    try {
      if (skill.id) {
        await updateSkill(skill.id, { enabled })
        capturePosthog('skill_enabled_changed', { scope: 'organization', enabled })
      } else {
        const { setCuratedSkillEnabled } = await import('@/adapters/api/skills-client')
        await setCuratedSkillEnabled(skill.name, enabled)
        capturePosthog('skill_enabled_changed', { scope: 'curated', enabled })
      }
    } catch {
      setSkills(
        (prev) =>
          prev?.map((row) =>
            selectionKey(row) === key ? { ...row, enabled: !enabled } : row,
          ) ?? prev,
      )
      toast.error(t('editor.saveError'))
    } finally {
      setTogglingIds((current) => current.filter((entry) => entry !== key))
    }
  }

  // A null confirmId means no deletion is pending — never match it against a
  // curated skill (whose id is also null).
  const confirmation = confirmId ? (skills?.find((skill) => skill.id === confirmId) ?? null) : null

  const filtered = useMemo(
    () => (skills ?? []).filter((skill) => matchesSkillQuery(skill, query)),
    [skills, query],
  )
  /** Everything this org wrote; the curated offers are listed separately. */
  const orgSkills = useMemo(
    () => filtered.filter((skill) => skill.origin !== 'platform'),
    [filtered],
  )
  const curated = useMemo(
    () => filtered.filter((skill) => skill.origin === 'platform'),
    [filtered],
  )
  const orgGroups = useMemo(() => groupSkillsByCategory(orgSkills, categories), [orgSkills, categories])
  const categoryName = useCallback(
    (id: string | null): string | null =>
      id ? (categories.find((category) => category.id === id)?.name ?? null) : null,
    [categories],
  )
  const orgCategories = useMemo(
    () => categories.filter((category) => category.scope === 'org'),
    [categories],
  )
  /**
   * How many skills stand on each category — counted over EVERY org skill, not
   * the search-filtered view.
   *
   * These counts feed the category manager, whose delete confirmation says how
   * many skills fall back to unsorted. Derived from the filtered list, a search
   * narrowing the page to one skill would promise that deleting a category
   * touches one skill while it silently unsorts thirty. A destructive action
   * states its real blast radius or it is not a confirmation.
   */
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const skill of skills ?? []) {
      if (skill.origin === 'platform') continue
      if (skill.categoryId) counts[skill.categoryId] = (counts[skill.categoryId] ?? 0) + 1
    }
    return counts
  }, [skills])

  const openDetail = useCallback((skill: SkillListItem) => {
    const key = selectionKey(skill)
    setSelected(key)
    syncSelectionToUrl(key)
  }, [])

  const closeDetail = useCallback(() => {
    setSelected(null)
    syncSelectionToUrl(null)
  }, [])

  const selectedSkill =
    selected === null
      ? null
      : ((skills ?? []).find((skill) => selectionKey(skill) === selected) ?? null)

  const searching = query.trim().length > 0

  return (
    <section className="space-y-4" aria-label={t('title')}>
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

      {skills !== null && !error && (skills.length > 0 || searching) && (
        <SearchField
          type="search"
          value={query}
          onChange={setQuery}
          placeholder={t('toolbox.search.placeholder')}
          label={t('toolbox.search.label')}
        />
      )}

      {skills !== null && !error && searching && filtered.length === 0 && (
        <EmptyState
          icon={Search}
          title={t('toolbox.search.noMatches', { query: query.trim() })}
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery('')}>
              {t('toolbox.search.showAll')}
            </Button>
          }
        />
      )}

      {skills !== null && !error && (!searching || filtered.length > 0) && (
        <CuratedSkills
          skills={curated}
          categories={categories}
          canManage={canManage}
          onSelect={openDetail}
          onToggled={(name, enabled) =>
            setSkills(
              (prev) =>
                prev?.map((row) => (row.name === name ? { ...row, enabled } : row)) ?? prev,
            )
          }
        />
      )}

      {/* The org's own, under a heading of their own — but ONLY once the
          featured section is there to be distinguished from. On a page with
          nothing curated yet, a lone "Your skills" heading over the only list
          on the page is a label for the page, which the page already has. */}
      {/* The heading is conditional; the way into the category manager is not.
          It used to ride inside this block, so an org with no curated offers —
          or a search matching only its own skills — lost the only door to the
          manager. A control that vanishes with an unrelated list is a control
          nobody can find twice. */}
      {skills !== null && !error && curated.length === 0 && canManage && (
        <div className="mt-8 flex items-center">
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground ml-auto"
            onClick={() => setCategoriesOpen(true)}
            data-testid="categories-manage-bare"
          >
            {t('toolbox.categories.button')}
          </Button>
        </div>
      )}

      {skills !== null && !error && curated.length > 0 && (!searching || orgGroups.length > 0) && (
        <div className="mt-8 flex items-center gap-2">
          <h2 className="text-foreground text-sm font-semibold tracking-[-0.01em]">
            {t('toolbox.ownHeading')}
          </h2>
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground ml-auto"
              onClick={() => setCategoriesOpen(true)}
              data-testid="categories-manage"
            >
              <Library className="size-3.5" aria-hidden />
              {t('toolbox.categories.button')}
            </Button>
          )}
        </div>
      )}

      {skills !== null && !error && !searching && orgSkills.length === 0 && (
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

      {(!searching || orgGroups.length > 0) &&
        orgGroups.map((group) => (
          <CategorySection
            key={group.category?.id ?? '__unsorted__'}
            group={group}
            canManage={canManage}
            togglingIds={togglingIds}
            onOpen={openDetail}
            onEdit={onEdit}
            onToggle={toggleEnabled}
            onDelete={(skill) => setConfirmId(skill.id)}
          />
        ))}

      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => !open && setConfirmId(null)}
        tone="destructive"
        title={t('editor.deleteTitle')}
        description={t('editor.deleteDescription', { name: confirmation?.name ?? '' })}
        confirmLabel={t('editor.deleteConfirm')}
        cancelLabel={t('editor.cancel')}
        pending={deletingId !== null}
        onConfirm={confirmDelete}
      />

      <SkillDetail
        skill={selectedSkill}
        categoryName={selectedSkill ? categoryName(selectedSkill.categoryId) : null}
        open={selected !== null}
        resolving={selected !== null && selectedSkill === null && skills === null}
        canManage={canManage}
        onEdit={(skill) => {
          closeDetail()
          onEdit(skill)
        }}
        onToggle={toggleEnabled}
        onDelete={(skill) => skill.id && setConfirmId(skill.id)}
        toggling={selectedSkill ? togglingIds.includes(selectionKey(selectedSkill)) : false}
        onClose={closeDetail}
      />

      {canManage && (
        <SkillCategoryManager
          open={categoriesOpen}
          onOpenChange={setCategoriesOpen}
          categories={orgCategories}
          counts={categoryCounts}
          onCreate={async (input) => createSkillCategory(input)}
          onRename={async (id, name) => updateSkillCategory(id, { name })}
          onDelete={async (id) => deleteSkillCategory(id)}
          onChanged={() => {
            load()
            onCategoriesChanged?.()
          }}
        />
      )}
    </section>
  )
}

/** The drawer key: an org row by id, a curated offer by name. */
function selectionKey(skill: SkillListItem): string {
  return skill.id ?? skill.name
}

interface CategorySectionProps {
  group: CategoryGroup
  canManage: boolean
  togglingIds: string[]
  onOpen: (skill: SkillListItem) => void
  onEdit: (skill: SkillListItem | null) => void
  onToggle: (skill: SkillListItem, enabled: boolean) => void
  onDelete: (skill: SkillListItem) => void
}

/**
 * One category of org skills: a subheading with its count, then the cards.
 *
 * The same card as a job and a file (components/ui/raised-card): a white
 * block laid into a tray, with the quiet provenance and the instruction
 * disclosure showing on the tray beneath it.
 */
function CategorySection({
  group,
  canManage,
  togglingIds,
  onOpen,
  onEdit,
  onToggle,
  onDelete,
}: CategorySectionProps): JSX.Element {
  const t = useTranslations('skills')
  return (
    <section aria-label={group.category?.name ?? t('toolbox.category.unsortedHeading')}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-foreground text-sm font-semibold tracking-[-0.01em]">
          {group.category?.name ?? t('toolbox.category.unsortedHeading')}
        </h3>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t('toolbox.categories.count', { count: group.skills.length })}
        </span>
      </div>
      <div className="grid animate-in fade-in-0 gap-4 duration-base ease-out motion-reduce:animate-none lg:grid-cols-2">
        {group.skills.map((skill) => (
          <RaisedCard key={skill.name}>
            <RaisedCardBody className="flex flex-1 flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                {/* Off is stated by the text going quiet, not by a badge
                    saying "disabled" next to a switch that already says it.
                    The card stays legible either way — it is off, not gone. */}
                <div
                  className={cn(
                    'min-w-0 space-y-1 transition-opacity duration-quick ease-out motion-reduce:transition-none',
                    !skill.enabled && 'opacity-45',
                  )}
                >
                  <h4 className="text-foreground truncate font-mono text-sm font-semibold">
                    {/* Shown as the token it is. A skill's name is not a title
                        — it is what somebody types after a slash in chat, and
                        this card is where an author learns that. The name opens
                        the drawer; everything around it stays text. */}
                    <button
                      type="button"
                      onClick={() => onOpen(skill)}
                      aria-label={t('toolbox.actions.openAria', { name: skill.name })}
                      className="rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2"
                    >
                      <span aria-hidden className="text-muted-foreground">
                        /
                      </span>
                      {skill.name}
                    </button>
                  </h4>
                  <p className="text-muted-foreground line-clamp-2 text-sm">
                    {skill.description}
                  </p>
                </div>

                <div
                  className="flex shrink-0 items-center gap-2"
                  onClick={(event) => event.stopPropagation()}
                >
                  {/* Scope, and ONLY when there is one. This used to be an
                      execution-mode badge on every row, which said what a
                      scheduled run would produce while reading as though it
                      said where the skill applied — and a badge every row
                      carries tells you nothing anyway. A skill reaches both
                      agents unless it says otherwise, so the badge appears
                      exactly when that is not true. */}
                  {agentScopeLabelKey(skill.metadata['grid-agents']) && (
                    <Badge variant="outline">
                      {t(`toolbox.scope.${agentScopeLabelKey(skill.metadata['grid-agents'])}`)}
                    </Badge>
                  )}
                  {canManage && (
                    <Switch
                      checked={skill.enabled}
                      disabled={togglingIds.includes(selectionKey(skill))}
                      onCheckedChange={(next) => void onToggle(skill, next)}
                      aria-label={t('toolbox.actions.enabledAria', { name: skill.name })}
                    />
                  )}
                </div>
              </div>

              {/* `mt-auto` pins the actions to the bottom of the white block,
                  so they line up across a grid row whose descriptions ran to
                  different lengths. */}
              {canManage && (
                <div
                  className="mt-auto flex flex-wrap items-center gap-2"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onEdit(skill)}
                    disabled={togglingIds.includes(selectionKey(skill))}
                  >
                    <Pencil className="size-3.5" aria-hidden />
                    {t('toolbox.actions.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => skill.id && onDelete(skill)}
                    disabled={togglingIds.includes(selectionKey(skill))}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    {t('toolbox.actions.delete')}
                  </Button>
                </div>
              )}
            </RaisedCardBody>

            {/* The tray: the state that is not the switch on the left, the way
                into the verbatim instruction on the right — the same one-row
                shape a job card's tray has.

                The left side speaks only when there is something to say. "In
                this organization" used to sit on every row, which is what the
                page already says; what is worth a line is a skill that is
                switched OFF, because a card the agent will never reach should
                say so somewhere that is not only a toggle's position. */}
            <RaisedCardFooter>
              <Collapsible className="w-full">
                <div className="flex w-full items-center gap-2">
                  {!skill.enabled && (
                    <span className="min-w-0 truncate">{t('toolbox.origin.disabled')}</span>
                  )}
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground group -my-1 ml-auto h-7 shrink-0 px-2"
                    >
                      <BookOpen className="size-3.5" aria-hidden />
                      {t('toolbox.actions.viewBody')}
                      <ChevronDown
                        className="size-3.5 shrink-0 transition-transform duration-quick ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                        aria-hidden
                      />
                    </Button>
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent className="pt-2 duration-base ease-out motion-reduce:animate-none">
                  <pre className="bg-muted text-foreground max-h-64 overflow-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-xs leading-relaxed">
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
