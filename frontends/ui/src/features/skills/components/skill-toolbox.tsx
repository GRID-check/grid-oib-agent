'use client'

/**
 * The Skills tab's content: the skills Piloti curates for every organization
 * (`curated-skills.tsx`), and then the ones this one wrote itself.
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
 * Authoring is gated on org:skills:manage; without it the page is read-only.
 * Nothing here is about time or output: a skill says neither.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, BookOpen, ChevronDown, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  deleteSkill,
  updateSkill,
  listSkills,
  type SkillListItem,
} from '@/adapters/api/skills-client'
import { agentScopeLabelKey } from '../lib/agent-scope'
import { ConfirmDeleteDialog } from './confirm-delete-dialog'
import { CuratedSkills } from './curated-skills'

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
}

export function SkillToolbox({ canManage, onEdit, reloadKey = 0 }: SkillToolboxProps): JSX.Element {
  const t = useTranslations('skills')
  const [skills, setSkills] = useState<SkillListItem[] | null>(null)
  const [error, setError] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  /** Ids whose switch is mid-flight, so it cannot be flipped twice. */
  const [togglingIds, setTogglingIds] = useState<string[]>([])

  const load = useCallback(() => {
    setSkills(null)
    setError(false)
    listSkills()
      .then(setSkills)
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
      setConfirmId(null)
      setSkills((prev) => prev?.filter((skill) => skill.id !== confirmId) ?? prev)
    } catch {
      toast.error(t('editor.saveError'))
    } finally {
      setDeletingId(null)
    }
  }

  /**
   * Flip a skill on or off.
   *
   * Optimistic, and reverted on failure. A switch that waits for a round trip
   * before moving is a switch you press twice — and this one is cheap to undo,
   * which is exactly the case optimism is for.
   */
  const toggleEnabled = async (skill: SkillListItem, enabled: boolean) => {
    const id = skill.id
    if (!id) return
    setTogglingIds((current) => [...current, id])
    setSkills((prev) => prev?.map((row) => (row.id === id ? { ...row, enabled } : row)) ?? prev)
    try {
      await updateSkill(id, { enabled })
    } catch {
      setSkills(
        (prev) => prev?.map((row) => (row.id === id ? { ...row, enabled: !enabled } : row)) ?? prev,
      )
      toast.error(t('editor.saveError'))
    } finally {
      setTogglingIds((current) => current.filter((entry) => entry !== id))
    }
  }

  // A null confirmId means no deletion is pending — never match it against a
  // curated skill (whose id is also null).
  const confirmation = confirmId ? (skills?.find((skill) => skill.id === confirmId) ?? null) : null

  /** Everything this org wrote; the curated offers are listed separately. */
  const orgSkills = skills?.filter((skill) => skill.origin !== 'platform') ?? []
  const curated = skills?.filter((skill) => skill.origin === 'platform') ?? []

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

      {skills !== null && !error && (
        <CuratedSkills
          skills={curated}
          canManage={canManage}
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
      {skills !== null && !error && curated.length > 0 && (
        <h2 className="text-foreground mt-8 text-sm font-semibold tracking-[-0.01em]">
          {t('toolbox.ownHeading')}
        </h2>
      )}

      {skills !== null && !error && orgSkills.length === 0 && (
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

      {orgSkills.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {orgSkills.map((skill) => (
            // The same card as a job and a file (components/ui/raised-card): a
            // white block laid into a tray, with the quiet provenance and the
            // instruction disclosure showing on the tray beneath it.
            <RaisedCard key={skill.name}>
              <RaisedCardBody className="flex flex-1 flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  {/* Off is stated by the text going quiet, not by a badge
                      saying "disabled" next to a switch that already says it.
                      The card stays legible either way — it is off, not gone. */}
                  <div
                    className={cn(
                      'min-w-0 space-y-1 transition-opacity duration-200 motion-reduce:transition-none',
                      !skill.enabled && 'opacity-45',
                    )}
                  >
                    <h3 className="text-foreground truncate font-mono text-sm font-semibold">
                      {/* Shown as the token it is. A skill's name is not a title
                          — it is what somebody types after a slash in chat, and
                          this card is where an author learns that. */}
                      <span aria-hidden className="text-muted-foreground">
                        /
                      </span>
                      {skill.name}
                    </h3>
                    <p className="text-muted-foreground line-clamp-2 text-sm">
                      {skill.description}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
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
                        disabled={togglingIds.includes(skill.id ?? '')}
                        onCheckedChange={(next) => void toggleEnabled(skill, next)}
                        aria-label={t('toolbox.actions.enabledAria', { name: skill.name })}
                      />
                    )}
                  </div>
                </div>

                {/* `mt-auto` pins the actions to the bottom of the white block,
                    so they line up across a grid row whose descriptions ran to
                    different lengths. */}
                {canManage && (
                  <div className="mt-auto flex flex-wrap items-center gap-2">
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
