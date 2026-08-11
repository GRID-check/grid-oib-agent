'use client'

/**
 * Skill toolbox — the "Skill toolbox" section of the Skills tab. Renders the
 * merged toolbox (builtin platform skills + org rows, org rows shadowing same
 * names) as raised cards: the name as the token it is, the description, the
 * agent scope where there is one, actions, and — on the card's footer tray —
 * the origin plus a collapsible verbatim instruction preview.
 * Nothing here is about time or output: a skill says neither. Builtin platform
 * skills can be cloned into the org; org-authored/cloned rows can be edited
 * and deleted (org:skills:manage — without it the section is read-only).
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  BookOpen,
  ChevronDown,
  Copy,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { deleteSkill, listSkills, type SkillListItem } from '@/adapters/api/skills-client'
import { agentScopeLabelKey } from '../lib/agent-scope'
import { ConfirmDeleteDialog } from './confirm-delete-dialog'

interface SkillToolboxProps {
  /** Whether this member may author/clone/edit/delete skills (org:skills:manage). */
  canManage: boolean
  /** Open the editor to clone a builtin platform skill. */
  onClone: (skill: SkillListItem) => void
  /** Open the editor for an org row (edit, or create empty from scratch). */
  onEdit: (skill: SkillListItem | null) => void
}

/**
 * Where the skill came from. This reads as plain text on the card's footer tab
 * rather than as a badge in the header: every row has an origin, and a badge
 * that is always present is decoration, not signal. The header keeps the badge
 * slot for the scope, which appears only when a skill is NOT available
 * everywhere — the thing worth a second look.
 */
function originLabel(t: ReturnType<typeof useTranslations>, skill: SkillListItem): string {
  if (skill.origin === 'platform') return t('toolbox.origin.platform')
  if (skill.origin === 'platform-clone') return t('toolbox.origin.cloned')
  return t('toolbox.origin.org')
}

export function SkillToolbox({ canManage, onClone, onEdit }: SkillToolboxProps): JSX.Element {
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
          <h2 id="skill-toolbox-heading" className="text-foreground text-sm font-semibold">
            {t('toolbox.heading')}
          </h2>
          <p className="text-muted-foreground max-w-3xl text-xs">{t('toolbox.hint')}</p>
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
            // The same card as a job and a file (components/ui/raised-card): a
            // white block laid into a tray, with the quiet provenance and the
            // instruction disclosure showing on the tray beneath it.
            <RaisedCard key={skill.name}>
              <RaisedCardBody className="flex flex-1 flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
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
                  {/* Scope, and ONLY when there is one. This used to be an
                      execution-mode badge on every row, which said what a
                      scheduled run would produce while reading as though it
                      said where the skill applied — and a badge every row
                      carries tells you nothing anyway. A skill reaches both
                      agents unless it says otherwise, so the badge appears
                      exactly when that is not true. */}
                  {agentScopeLabelKey(skill.metadata['grid-agents']) && (
                    <Badge variant="outline" className="shrink-0">
                      {t(`toolbox.scope.${agentScopeLabelKey(skill.metadata['grid-agents'])}`)}
                    </Badge>
                  )}
                </div>

                {/* `mt-auto` pins the actions to the bottom of the white block,
                    so they line up across a grid row whose descriptions ran to
                    different lengths. */}
                {canManage && (
                  <div className="mt-auto flex flex-wrap items-center gap-2">
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
              </RaisedCardBody>

              {/* The tray: where the skill came from on the left, the way into
                  its verbatim instruction on the right — the same one-row shape
                  a job card's tray has. */}
              <RaisedCardFooter>
                <Collapsible className="w-full">
                  <div className="flex w-full items-center gap-2">
                    <span className="min-w-0 truncate">{originLabel(t, skill)}</span>
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
