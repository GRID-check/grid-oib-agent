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
 */

import { useCallback, useEffect, useState, type FC } from 'react'
import { FolderKanban } from 'lucide-react'

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

/** The two fields this picker needs; `/api/projects` carries many more. */
interface PickerProject {
  id: string
  name: string
}

export interface ProjectMountPickerProps {
  /** Projects already in view — rows stay, disabled and badged. */
  mountedIds: readonly string[]
  /** At the cap no further project may be added. */
  capReached: boolean
  /** The cap itself, as the server stated it — for the footer's sentence. */
  cap: number
  onMount: (projectId: string, projectName: string) => void
  /** The offer behind the cap: the existing deep-research path. */
  onDeepResearch: () => void
  /** Test seam: the project list, when a caller already holds one. */
  projects?: readonly PickerProject[]
}

/** Rows from the same endpoint the palette and the switcher read. */
const fetchProjects = async (): Promise<PickerProject[]> => {
  const res = await fetch('/api/projects')
  if (!res.ok) throw new Error(`projects ${res.status}`)
  const rows = (await res.json()) as Array<{ id?: unknown; name?: unknown }>
  return rows
    .filter((row): row is { id: string; name: string } =>
      typeof row?.id === 'string' && typeof row?.name === 'string'
    )
    .map((row) => ({ id: row.id, name: row.name }))
}

export const ProjectMountPicker: FC<ProjectMountPickerProps> = ({
  mountedIds,
  capReached,
  cap,
  onMount,
  onDeepResearch,
  projects: given,
}) => {
  const t = useTranslations('chat')
  const [projects, setProjects] = useState<PickerProject[] | null>(given ? [...given] : null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (given) return
    let cancelled = false
    setFailed(false)
    fetchProjects()
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
  }, [given, attempt])

  const retry = useCallback(() => {
    setProjects(null)
    setAttempt((n) => n + 1)
  }, [])

  const loading = projects === null

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
          <>
            <CommandEmpty>{t('workspace.picker.empty')}</CommandEmpty>
            <CommandGroup>
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
          </>
        )}
      </CommandList>

      {capReached && (
        <div className="border-t p-2">
          <MountCapNotice max={cap} onDeepResearch={onDeepResearch} />
        </div>
      )}
    </Command>
  )
}
