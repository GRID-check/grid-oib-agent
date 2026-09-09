'use client'

/**
 * The Wissensbasis — the one control, on BOTH surfaces, that states the
 * knowledge levels in authority order and says which of them this turn may read
 * (`workspace-chat-ui.md` §4).
 *
 * ## It reports and it mounts; it does not toggle
 *
 * Four states from the Datenbasis vocabulary render here and only two of them
 * are reachable by pressing something: mounting a project and unmounting one.
 * Anything else would be a control promising retrieval behaviour the backend
 * does not have (`click-dummy-overhaul-spec.md` §2.3). An `off` row therefore
 * states WHERE it was turned off and offers the way back — "Voreinstellung
 * zurücksetzen", which clears the shortcut preset (§10.1: the Datenbasis picker
 * stays hidden, so the foot of this tree is not a link into it).
 *
 * ## Not `role="tree"`
 *
 * An ARIA tree promises roving focus and expand/collapse that this hierarchy
 * does not have and the reader would have to learn. It is nested lists, each
 * level a list item labelled by its own heading, and every row states its
 * status IN WORDS beside the colour and the glyph.
 */

import { useState, type FC } from 'react'
import { Archive, ArrowRight, FileText, FolderKanban, MessageSquare, Plus, Scale, X, type LucideIcon } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { sourceSignalStyle } from '../SourceSignalChip'
import { ProjectMountPicker } from './ProjectMountPicker'
import type { MountedProject, ScopeLevel, ScopeLevelId } from './scope-tree-model'

/**
 * Glyph per level (§6). The two NEW levels take an existing tint and a new
 * glyph — the mechanism ADR-0026's amendment established for `oib` inside
 * `law` — because a Steckbrief is not a different tier of trust from a project
 * document, only a coarser grain of the same one.
 */
const LEVEL_ICON: Record<ScopeLevelId, LucideIcon> = {
  base: Scale,
  archiv: Archive,
  register: FolderKanban,
  project: FileText,
  session: MessageSquare,
}

export interface ScopeTreeProps {
  levels: readonly ScopeLevel[]
  /** The cap, as the server stated it — the picker's footer needs the number. */
  cap: number
  /** True while the mount list is still being fetched. */
  loading?: boolean
  /** Projects whose mount/unmount is in flight. */
  pending?: readonly string[]
  /** The last mount failure, as a sentence the tree can show inline. */
  error?: string | null
  onMount: (projectId: string, projectName: string) => void
  /** Show a whole Sammlung (spec GR-2). Absent where the picker offers none. */
  onMountSet?: (projectSetId: string, setName: string) => void
  onUnmount: (projectId: string) => void
  /** Opens the Sammlungen manager, from the picker's footer. */
  onManageSets?: () => void
  onRetry?: () => void
  /** Clears the shortcut preset that excluded a level (§10.1). */
  onResetPreset?: () => void
  /** The offer behind the cap. */
  onDeepResearch: () => void
  /**
   * Only in a project chat: the doorway into the Büro with this project in
   * view. It replaces the disabled "Alle Projekte · Bald verfügbar" row, which
   * existed because there was nothing behind it — and now there is.
   */
  onAskInWorkspace?: () => void
}

/** One level's status, in words. Colour and glyph never carry it alone. */
const StatusWord: FC<{ level: ScopeLevel }> = ({ level }) => {
  const t = useTranslations('chat')
  return (
    <span className="text-muted-foreground shrink-0 text-xs">
      {t(`workspace.tree.states.${level.state}`)}
    </span>
  )
}

const MountedRow: FC<{
  project: MountedProject
  pending: boolean
  onUnmount: (projectId: string) => void
}> = ({ project, pending, onUnmount }) => {
  const t = useTranslations('chat')
  return (
    <li className="flex min-h-8 items-center gap-2 pl-6 pr-1">
      <span
        className="flex size-4 shrink-0 items-center justify-center rounded-full"
        style={sourceSignalStyle('project')}
      >
        <FolderKanban className="size-2.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{project.projectName}</span>
      {pending ? (
        <Spinner size="sm" label={project.projectName} className="size-3.5" />
      ) : (
        <button
          type="button"
          onClick={() => onUnmount(project.projectId)}
          aria-label={t('workspace.tree.mountRemove', { project: project.projectName })}
          className="focus-visible:ring-ring/60 pointer-coarse:size-11 text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </li>
  )
}

export const ScopeTree: FC<ScopeTreeProps> = ({
  levels,
  cap,
  loading = false,
  pending = [],
  error = null,
  onMount,
  onMountSet,
  onUnmount,
  onManageSets,
  onRetry,
  onResetPreset,
  onDeepResearch,
  onAskInWorkspace,
}) => {
  const t = useTranslations('chat')
  const [pickerOpen, setPickerOpen] = useState(false)
  const mountedIds = levels
    .flatMap((level) => level.mounted ?? [])
    .map((project) => project.projectId)

  return (
    <div className="flex flex-col gap-2" data-testid="scope-tree">
      <SectionLabel as="h2">{t('workspace.tree.title')}</SectionLabel>

      {loading ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-4/5" />
        </div>
      ) : (
        <ul className="flex flex-col">
          {levels.map((level) => {
            const Icon = LEVEL_ICON[level.id]
            const dimmed = level.state === 'unavailable' || level.state === 'off'
            return (
              <li key={level.id} className="flex flex-col">
                <div
                  className={cn(
                    'pointer-coarse:min-h-11 flex min-h-9 items-center gap-2 rounded-lg px-1.5',
                    dimmed && 'opacity-70'
                  )}
                  data-testid={`scope-level-${level.id}`}
                  data-state={level.state}
                >
                  <span
                    className="flex size-5 shrink-0 items-center justify-center rounded-md"
                    style={
                      dimmed ? sourceSignalStyle('auto') : sourceSignalStyle(level.signal)
                    }
                  >
                    <Icon className="size-3" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {t(`workspace.tree.levels.${level.id}`)}
                  </span>
                  <StatusWord level={level} />
                </div>

                {/* The hint sits under the level it qualifies, at the indent of
                    its rows: "nur Namen und Steckbriefe" is what stops the Büro
                    being read as "all our projects" (§3, failure mode 4).

                    A locked project chat is the one row that says something
                    truer than the hint — the hint speaks of "eingeblendete
                    Projekte", and there are none here by construction — so the
                    lock sentence below stands in its place rather than under
                    it. */}
                {(!!level.reason || !(level.id === 'project' && level.lockedProjectName)) && (
                  <p className="text-muted-foreground pl-8 pr-1 text-xs leading-snug">
                    {level.reason
                      ? t(level.reason.key, level.reason.values)
                      : t(`workspace.tree.hints.${level.id}`)}
                  </p>
                )}

                {/* An `off` row states where it was turned off AND offers the
                    way back. A state with no way out of it is the thing the
                    Datenbasis vocabulary exists to keep honest. */}
                {level.state === 'off' && level.reason && onResetPreset && (
                  <div className="pl-8">
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={onResetPreset}
                      className="touch-target h-auto p-0 text-xs"
                    >
                      {t('workspace.tree.resetPreset')}
                    </Button>
                  </div>
                )}

                {level.id === 'project' && level.lockedProjectName && (
                  <p className="text-muted-foreground pl-8 pr-1 text-xs leading-snug">
                    {t('workspace.tree.projectLocked', { project: level.lockedProjectName })}
                  </p>
                )}

                {level.id === 'project' && level.mounted && (
                  <>
                    {level.mounted.length === 0 ? (
                      <p className="text-muted-foreground pl-8 pr-1 text-xs">
                        {t('workspace.tree.noProjects')}
                      </p>
                    ) : (
                      <ul className="flex flex-col">
                        {level.mounted.map((project) => (
                          <MountedRow
                            key={project.projectId}
                            project={project}
                            pending={pending.includes(project.projectId)}
                            onUnmount={onUnmount}
                          />
                        ))}
                      </ul>
                    )}

                    {level.canMount ? (
                      <div className="pl-6">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setPickerOpen((open) => !open)}
                          aria-expanded={pickerOpen}
                          data-testid="scope-tree-mount-add"
                          className="pointer-coarse:min-h-11 h-8 w-full justify-start px-1.5 text-xs"
                        >
                          <Plus className="size-3.5" aria-hidden="true" />
                          {t('workspace.tree.mountAdd')}
                        </Button>
                      </div>
                    ) : (
                      <p
                        className="text-muted-foreground pl-8 pr-1 text-xs"
                        data-testid="scope-tree-cap-reason"
                      >
                        {t('workspace.cap.notice', { max: cap })}
                      </p>
                    )}

                    {pickerOpen && (
                      <div className="mt-1 rounded-lg border">
                        <ProjectMountPicker
                          mountedIds={mountedIds}
                          capReached={!level.canMount}
                          cap={cap}
                          onMount={onMount}
                          onMountSet={onMountSet}
                          onManageSets={onManageSets}
                          onDeepResearch={onDeepResearch}
                        />
                      </div>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex w-full items-center justify-between gap-2">
            <span className="text-xs">{error}</span>
            {onRetry && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {t('workspace.picker.retry')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* The foot of a project chat's tree: the honest replacement for the
          disabled "Alle Projekte · Bald verfügbar" row. */}
      {onAskInWorkspace && (
        <div className="border-t pt-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onAskInWorkspace}
            title={t('workspace.askInWorkspaceHint')}
            data-testid="ask-in-workspace"
            className="pointer-coarse:min-h-11 h-8 w-full justify-start px-1.5 text-xs"
          >
            <ArrowRight className="size-3.5" aria-hidden="true" />
            {t('workspace.askInWorkspace')}
          </Button>
        </div>
      )}
    </div>
  )
}
