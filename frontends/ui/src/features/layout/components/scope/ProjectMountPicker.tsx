'use client'

/**
 * "+ Projekt einblenden" (`workspace-chat-ui.md` §4).
 *
 * `Command`-based, so it inherits the ↑↓ / Enter / Esc contract the `/` skill
 * picker and the `@` mention picker already teach — the reader learns one list
 * interaction in this product, not three.
 *
 * Rows are the readable projects from `GET /api/projects`, the same FGA-filtered
 * list the switcher and the palette use. A project the reader cannot open is
 * never a row, so this picker cannot leak a name (ADR-0038); that is a property
 * of the endpoint, and it is why this component may render names at all.
 *
 * Three shapes are deliberate:
 *  - An already-mounted project stays in the list, disabled, with a badge. Not
 *    filtered out — the list must not reorder under the reader's cursor as they
 *    mount, and mounting three projects is one task, not three.
 *  - At the cap every unmounted row is `aria-disabled` WITH the reason visible,
 *    and the footer offers the one path that reads more than the cap allows.
 *  - A fetch failure is an inline `Alert` with a retry inside the list, not an
 *    empty list: "we could not ask" and "there is nothing" are different facts.
 *
 * ## Sammlungen sit ABOVE the projects, in their own group
 *
 * A Sammlung is the coarser gesture — five projects in one Enter (spec GR-2) —
 * and `CommandGroup` is what says "these rows are a different kind of thing"
 * without a second list to arrow between. They lead because the reader who has
 * one wants it before they start naming projects one at a time; the reader who
 * has none never sees the group at all, and the picker is exactly what it was.
 *
 * A set row states the number of projects THIS reader would actually mount —
 * the server's per-caller `projectCount` — so the number beside the name and
 * the number the cap is measured against are the same number.
 */

import { useCallback, useEffect, useState, type FC } from 'react'
import { FolderKanban, Layers, Settings2 } from 'lucide-react'

import { projectSetsClient, type ProjectSetSummary } from '@/adapters/api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { MountCapNotice } from '@/features/chat/components/MountNotice'
import { fetchReadableProjects, type ReadableProject } from './readable-projects'

export interface ProjectMountPickerProps {
  /** Projects already in view — rows stay, disabled and badged. */
  mountedIds: readonly string[]
  /** At the cap no further project may be added. */
  capReached: boolean
  /** The cap itself, as the server stated it — for the footer's sentence. */
  cap: number
  onMount: (projectId: string, projectName: string) => void
  /** Show a whole Sammlung. One Enter, one cap check, one refusal (GR-2). */
  onMountSet?: (projectSetId: string, setName: string) => void
  /** The offer behind the cap: the existing deep-research path. */
  onDeepResearch: () => void
  /** Opens the Sammlungen manager. Absent where there is nowhere to put it. */
  onManageSets?: () => void
  /** Test seam: the project list, when a caller already holds one. */
  projects?: readonly ReadableProject[]
  /** Test seam: the Sammlungen, when a caller already holds them. */
  sets?: readonly ProjectSetSummary[]
}

export const ProjectMountPicker: FC<ProjectMountPickerProps> = ({
  mountedIds,
  capReached,
  cap,
  onMount,
  onMountSet,
  onDeepResearch,
  onManageSets,
  projects: givenProjects,
  sets: givenSets,
}) => {
  const t = useTranslations('chat')
  const [projects, setProjects] = useState<ReadableProject[] | null>(
    givenProjects ? [...givenProjects] : null
  )
  const [sets, setSets] = useState<readonly ProjectSetSummary[]>(givenSets ? [...givenSets] : [])
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (givenProjects) return
    let cancelled = false
    setFailed(false)
    fetchReadableProjects()
      .then((rows) => {
        if (!cancelled) setProjects(rows)
      })
      .catch(() => {
        if (!cancelled) {
          setProjects([])
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [givenProjects, attempt])

  // Sammlungen load BESIDE the projects, never in front of them. A reader with
  // no Sammlung — which is every reader on day one — must not wait on a list
  // that will come back empty, and a Sammlungen outage must not take the
  // picker's actual job with it: the group simply does not appear.
  useEffect(() => {
    if (givenSets) return
    let cancelled = false
    projectSetsClient
      .list()
      .then((rows) => {
        if (!cancelled) setSets(rows)
      })
      .catch(() => {
        if (!cancelled) setSets([])
      })
    return () => {
      cancelled = true
    }
  }, [givenSets, attempt])

  const retry = useCallback(() => {
    setProjects(null)
    setAttempt((n) => n + 1)
  }, [])

  const loading = projects === null
  const showSets = !loading && !failed && onMountSet && sets.length > 0

  return (
    <Command
      // The list is already the readable set; filtering is the search field's
      // job and cmdk's default scoring is what the other two pickers use.
      data-testid="project-mount-picker"
      label={t('workspace.picker.title')}
    >
      <CommandInput placeholder={t('workspace.picker.placeholder')} autoFocus />
      <CommandList>
        {loading && (
          <div className="flex flex-col gap-1.5 p-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        )}

        {failed && (
          <div className="p-2">
            <Alert variant="destructive">
              <AlertDescription className="flex w-full items-center justify-between gap-2">
                <span>{t('workspace.picker.error')}</span>
                <Button type="button" variant="outline" size="sm" onClick={retry}>
                  {t('workspace.picker.retry')}
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}

        {!loading && !failed && (projects.length > 0 || showSets) && (
          <CommandEmpty>{t('workspace.picker.empty')}</CommandEmpty>
        )}

        {showSets && (
          <CommandGroup heading={t('workspace.sets.label')}>
            {sets.map((set) => {
              // A Sammlung this reader may read nothing of would widen the
              // scope by nothing, so it is disabled with that as its reason —
              // present rather than hidden, because a name that vanishes reads
              // as a bug and this one is the reader's own vocabulary.
              const empty = set.projectCount === 0
              const blocked = capReached || empty
              return (
                <CommandItem
                  key={set.id}
                  value={`${set.name} ${set.id}`}
                  disabled={blocked}
                  aria-disabled={blocked}
                  onSelect={() => {
                    if (!blocked) onMountSet(set.id, set.name)
                  }}
                  className="pointer-coarse:min-h-11 gap-2"
                  data-testid="project-set-row"
                >
                  <Layers className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{set.name}</span>
                  {/* The reason is VISIBLE on every blocked row — the same rule
                      the project rows follow, for the same reason. */}
                  {capReached ? (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t('workspace.cap.notice', { max: cap })}
                    </span>
                  ) : (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {empty
                        ? t('workspace.sets.emptyReason')
                        : t('workspace.sets.count', { count: set.projectCount })}
                    </span>
                  )}
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}

        {!loading && !failed && projects.length === 0 && (
          <div className="p-2">
            <EmptyState
              variant="bare"
              icon={FolderKanban}
              title={t('workspace.picker.none')}
              className="py-4"
            />
          </div>
        )}

        {!loading && !failed && projects.length > 0 && (
          <CommandGroup heading={showSets ? t('workspace.tree.levels.project') : undefined}>
            {projects.map((project) => {
              const isMounted = mountedIds.includes(project.id)
              const blocked = isMounted || capReached
              return (
                <CommandItem
                  key={project.id}
                  value={`${project.name} ${project.id}`}
                  disabled={blocked}
                  aria-disabled={blocked}
                  onSelect={() => {
                    if (!blocked) onMount(project.id, project.name)
                  }}
                  className="pointer-coarse:min-h-11 gap-2"
                  data-testid="project-mount-row"
                >
                  <FolderKanban className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {/* The reason is VISIBLE on every blocked row, never only in
                      the footer: a row the reader cannot press has to say why
                      where they pressed it. */}
                  {isMounted ? (
                    <Badge variant="secondary">{t('workspace.picker.mounted')}</Badge>
                  ) : capReached ? (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t('workspace.cap.notice', { max: cap })}
                    </span>
                  ) : null}
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
      </CommandList>

      {(capReached || onManageSets) && (
        <div className="flex flex-col gap-1.5 border-t p-2">
          {capReached && <MountCapNotice max={cap} onDeepResearch={onDeepResearch} />}
          {/* The door to the vocabulary itself. It lives in the footer rather
              than as a row, because naming a Sammlung is not one of the things
              this list mounts — and a row that navigates among rows that mount
              is the confusion the Command contract exists to prevent. */}
          {onManageSets && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onManageSets}
              data-testid="manage-project-sets"
              className="pointer-coarse:min-h-11 h-8 w-full justify-start px-1.5 text-xs"
            >
              <Settings2 className="size-3.5" aria-hidden="true" />
              {t('workspace.sets.manage')}
            </Button>
          )}
        </div>
      )}
    </Command>
  )
}
