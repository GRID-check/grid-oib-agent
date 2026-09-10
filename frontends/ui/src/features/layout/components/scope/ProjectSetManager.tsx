'use client'

/**
 * Sammlungen verwalten — the vocabulary behind the picker's set rows (GR-2).
 *
 * A Sammlung is a LABEL over projects: naming five projects grants nobody
 * anything, the mount still asks `project:chat` per project, and reading the
 * set still asks `project:view` per project. That is why this panel exists at
 * all rather than living in an administration surface — the right to keep a
 * personal shorthand is the ordinary right to use the Büro.
 *
 * ## The server decides; this panel reports
 *
 * `editable` comes off the wire and is never inferred. "I created it" and "I am
 * an organization project administrator" are both true of sets a reader may
 * change, and only the server knows the second — so a `createdBy === me` here
 * would grey out an administrator's controls AND offer controls that 403.
 * A set this reader may not edit still shows, with its reason, because it is
 * the office's shared vocabulary and hiding it would make the picker's rows
 * unexplainable.
 *
 * ## One panel, two depths
 *
 * The list is the resting state; one set at a time opens in place with its
 * members. Not a second dialog: this panel is already reached from a picker
 * inside a popover, and a third overlay is the "two overlays deep and one
 * outside-click away from losing both" trap §8 names. The only thing that DOES
 * get its own overlay is the delete, because a destructive action confirmed
 * inline is a destructive action confirmed by accident.
 *
 * Deleting takes the label and its memberships and NOTHING else — a
 * conversation that mounted the set holds ordinary mount rows from the moment
 * they were written (MT-14), so the name going away never changes what a thread
 * reads. That is why it is a `ConfirmDialog` and not the type-to-confirm
 * ladder: `TypeToConfirmDialog` is for loss that cannot be reconstructed, and
 * this loss is five clicks.
 */

import { useCallback, useEffect, useMemo, useState, type FC } from 'react'
import { ArrowLeft, Layers, Plus, Trash2, X } from 'lucide-react'

import {
  projectSetsClient,
  ProjectSetRefusedError,
  type ProjectSetDetail,
  type ProjectSetSummary,
} from '@/adapters/api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemList,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { fetchReadableProjects, type ReadableProject } from './readable-projects'

export interface ProjectSetManagerProps {
  /** Test seam / preview seam: the Sammlungen, when a caller already holds them. */
  sets?: readonly ProjectSetSummary[]
  /** Test seam / preview seam: the readable project list. */
  projects?: readonly ReadableProject[]
  /** Test seam / preview seam: open straight into this set's members. */
  initialSetId?: string
}

/** The refusal codes this panel has a sentence for. */
const REFUSAL_KEY = {
  duplicate_name: 'workspace.sets.errors.duplicateName',
  not_editable: 'workspace.sets.errors.notEditable',
  not_found: 'workspace.sets.errors.notFound',
  unavailable: 'workspace.sets.errors.unavailable',
} as const

const refusalKey = (error: unknown): string =>
  error instanceof ProjectSetRefusedError
    ? REFUSAL_KEY[error.code]
    : REFUSAL_KEY.unavailable

export const ProjectSetManager: FC<ProjectSetManagerProps> = ({
  sets: givenSets,
  projects: givenProjects,
  initialSetId,
}) => {
  const t = useTranslations('chat')
  const tCommon = useTranslations('common')

  const [sets, setSets] = useState<readonly ProjectSetSummary[] | null>(
    givenSets ? [...givenSets] : null
  )
  const [projects, setProjects] = useState<readonly ReadableProject[]>(
    givenProjects ? [...givenProjects] : []
  )
  const [openSetId, setOpenSetId] = useState<string | null>(initialSetId ?? null)
  const [detail, setDetail] = useState<ProjectSetDetail | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [pendingDelete, setPendingDelete] = useState<ProjectSetSummary | null>(null)

  const reload = useCallback(async () => {
    try {
      const rows = await projectSetsClient.list()
      setSets(rows)
      setLoadFailed(false)
    } catch {
      setSets([])
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    if (givenSets) return
    void reload()
  }, [givenSets, reload])

  useEffect(() => {
    if (givenProjects) return
    let cancelled = false
    fetchReadableProjects()
      .then((rows) => {
        if (!cancelled) setProjects(rows)
      })
      // The project list failing costs this panel its ADD control and nothing
      // else; the sets themselves are still readable and still deletable.
      .catch(() => {
        if (!cancelled) setProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [givenProjects])

  // The open set's members are read fresh: `projectCount` on the summary is a
  // number, and the members are names the reader is about to act on.
  useEffect(() => {
    if (!openSetId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetail(null)
    projectSetsClient
      .get(openSetId)
      .then((set) => {
        if (!cancelled) setDetail(set)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorKey(refusalKey(error))
          setOpenSetId(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [openSetId])

  /** One write, with the refusal turned into the sentence it has. */
  const run = useCallback(
    async (write: () => Promise<void>): Promise<boolean> => {
      setBusy(true)
      setErrorKey(null)
      try {
        await write()
        await reload()
        return true
      } catch (error) {
        setErrorKey(refusalKey(error))
        return false
      } finally {
        setBusy(false)
      }
    },
    [reload]
  )

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const created = await run(async () => {
      const set = await projectSetsClient.create({
        name: trimmed,
        description: description.trim() || null,
      })
      setOpenSetId(set.id)
    })
    if (created) {
      setName('')
      setDescription('')
      setCreating(false)
    }
  }, [description, name, run])

  const handleRename = useCallback(async () => {
    if (!detail) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === detail.name) return
    await run(async () => {
      setDetail(await projectSetsClient.update(detail.id, { name: trimmed }))
    })
  }, [detail, name, run])

  const addProject = useCallback(
    async (projectId: string) => {
      if (!detail) return
      await run(async () => {
        setDetail(await projectSetsClient.addProjects(detail.id, [projectId]))
      })
    },
    [detail, run]
  )

  const removeProject = useCallback(
    async (projectId: string) => {
      if (!detail) return
      await run(async () => {
        setDetail(await projectSetsClient.removeProjects(detail.id, [projectId]))
      })
    },
    [detail, run]
  )

  const confirmDelete = useCallback(async () => {
    const target = pendingDelete
    if (!target) return
    const done = await run(() => projectSetsClient.remove(target.id))
    if (done) {
      setPendingDelete(null)
      if (openSetId === target.id) setOpenSetId(null)
    }
  }, [openSetId, pendingDelete, run])

  /** Projects not yet in the open set — the only ones the add list may offer. */
  const addable = useMemo(() => {
    if (!detail) return []
    const held = new Set(detail.projects.map((project) => project.id))
    return projects.filter((project) => !held.has(project.id))
  }, [detail, projects])

  const error = errorKey ? <ErrorLine>{t(errorKey)}</ErrorLine> : null

  if (openSetId) {
    return (
      <div className="flex flex-col gap-3" data-testid="project-set-manager">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpenSetId(null)}
            className="pointer-coarse:min-h-11 h-8 px-1.5 text-xs"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {t('workspace.sets.back')}
          </Button>
        </div>

        {!detail ? (
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="project-set-name">{t('workspace.sets.nameLabel')}</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="project-set-name"
                  defaultValue={detail.name}
                  disabled={!detail.editable || busy}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!detail.editable || busy}
                  onClick={() => void handleRename()}
                >
                  {t('workspace.sets.save')}
                </Button>
              </div>
            </Field>

            {!detail.editable && (
              <p className="text-muted-foreground text-xs">{t('workspace.sets.readOnly')}</p>
            )}

            <SectionLabel as="h3">{t('workspace.sets.projectsLabel')}</SectionLabel>
            {detail.projects.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('workspace.sets.noProjects')}</p>
            ) : (
              <ItemList as="ul">
                {detail.projects.map((project) => (
                  <Item as="li" key={project.id} className="py-2">
                    <ItemContent>
                      <ItemTitle>{project.name}</ItemTitle>
                    </ItemContent>
                    {detail.editable && (
                      <ItemActions>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          disabled={busy}
                          aria-label={t('workspace.sets.remove', { project: project.name })}
                          onClick={() => void removeProject(project.id)}
                        >
                          <X className="size-3.5" aria-hidden="true" />
                        </Button>
                      </ItemActions>
                    )}
                  </Item>
                ))}
              </ItemList>
            )}

            {detail.editable && (
              <div className="rounded-lg border">
                <Command label={t('workspace.sets.addLabel')}>
                  <CommandInput placeholder={t('workspace.sets.addPlaceholder')} />
                  <CommandList>
                    <CommandEmpty>{t('workspace.sets.addEmpty')}</CommandEmpty>
                    {addable.map((project) => (
                      <CommandItem
                        key={project.id}
                        value={`${project.name} ${project.id}`}
                        disabled={busy}
                        onSelect={() => void addProject(project.id)}
                        className="pointer-coarse:min-h-11 gap-2"
                        data-testid="project-set-add-row"
                      >
                        <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      </CommandItem>
                    ))}
                  </CommandList>
                </Command>
              </div>
            )}
          </>
        )}

        {error}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="project-set-manager">
      <p className="text-muted-foreground text-xs leading-snug">
        {t('workspace.sets.description')}
      </p>

      {sets === null ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : loadFailed ? (
        <Alert variant="destructive">
          <AlertDescription className="flex w-full items-center justify-between gap-2">
            <span className="text-xs">{t('workspace.sets.errors.load')}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
              {t('workspace.picker.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : sets.length === 0 ? (
        <EmptyState
          variant="bare"
          icon={Layers}
          title={t('workspace.sets.none')}
          description={t('workspace.sets.noneHint')}
          className="py-6"
        />
      ) : (
        <ItemList as="ul">
          {sets.map((set) => (
            <Item as="li" key={set.id} className="py-2">
              <ItemMedia className="size-6">
                <Layers className="size-3.5" aria-hidden="true" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{set.name}</ItemTitle>
                <ItemDescription>
                  {set.description
                    ? `${set.description} · ${t('workspace.sets.count', { count: set.projectCount })}`
                    : t('workspace.sets.count', { count: set.projectCount })}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={busy}
                  aria-label={t('workspace.sets.edit', { name: set.name })}
                  onClick={() => {
                    setName(set.name)
                    setOpenSetId(set.id)
                  }}
                >
                  {set.editable ? t('workspace.sets.rename') : t('workspace.sets.projectsLabel')}
                </Button>
                {/* No control at all where the server says there is none — a
                    delete that can only 403 is worse than no delete. */}
                {set.editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive size-8"
                    disabled={busy}
                    aria-label={t('workspace.sets.deleteConfirm', { name: set.name })}
                    onClick={() => setPendingDelete(set)}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                )}
              </ItemActions>
            </Item>
          ))}
        </ItemList>
      )}

      {creating ? (
        <div className="flex flex-col gap-2 rounded-lg border p-2">
          <Field>
            <FieldLabel htmlFor="new-project-set-name">
              {t('workspace.sets.nameLabel')}
            </FieldLabel>
            <Input
              id="new-project-set-name"
              value={name}
              autoFocus
              disabled={busy}
              placeholder={t('workspace.sets.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-project-set-description">
              {t('workspace.sets.descriptionLabel')}
            </FieldLabel>
            <Input
              id="new-project-set-description"
              value={description}
              disabled={busy}
              placeholder={t('workspace.sets.descriptionPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || name.trim() === ''}
              onClick={() => void handleCreate()}
              data-testid="create-project-set"
            >
              {busy && <Spinner size="sm" className="size-3.5" />}
              {t('workspace.sets.createSubmit')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setCreating(false)
                setName('')
                setDescription('')
              }}
            >
              {tCommon('actions.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:min-h-11 justify-start"
          onClick={() => setCreating(true)}
          data-testid="new-project-set"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t('workspace.sets.create')}
        </Button>
      )}

      {error}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null)
        }}
        title={t('workspace.sets.deleteConfirm', { name: pendingDelete?.name ?? '' })}
        description={t('workspace.sets.deleteHint')}
        confirmLabel={t('workspace.sets.delete')}
        cancelLabel={tCommon('actions.cancel')}
        confirmTestId="confirm-delete-project-set"
        onConfirm={confirmDelete}
      />
    </div>
  )
}

/** One inline refusal, in the shape every other refusal on this path takes. */
const ErrorLine: FC<{ children: React.ReactNode }> = ({ children }) => (
  <Alert variant="destructive" data-testid="project-set-error">
    <AlertDescription>
      <span className="text-xs">{children}</span>
    </AlertDescription>
  </Alert>
)
