'use client'

/**
 * "Im Blick" — the projects this conversation may read, directly above the
 * composer, in the Büro only (`workspace-chat-ui.md` §4).
 *
 * One of the three simultaneous signals every mount produces (the others are
 * the chip's count and the tree's row). All three are rendered from the same
 * mount list, so there is no code path that widens the scope without all of
 * them saying so.
 *
 * ## Two shapes this deliberately does NOT take
 *
 * The `×` is a SIBLING of the chip inside a shared bordered wrapper, never a
 * button nested in the chip's own button: a control inside a control is invalid
 * HTML that passes a visual review and breaks keyboard navigation — the trap
 * the `ProjectOpenLink` / `ProjectSettingsLink` layering on project cards exists
 * to avoid.
 *
 * And it is PRESENT, not hover-revealed. Removing something you can see is the
 * undo of a one-click action; hiding it behind a hover is the extra turn the
 * working-style rule calls a correction.
 */

import { type FC } from 'react'
import { FolderKanban, X } from 'lucide-react'

import { SectionLabel } from '@/components/ui/section-label'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { sourceSignalStyle } from '../SourceSignalChip'
import type { MountedProject } from './scope-tree-model'

export interface MountedProjectsRowProps {
  mounted: readonly MountedProject[]
  /** Take one back out of view. */
  onUnmount: (projectId: string) => void
  /** Projects whose removal is in flight — dimmed, not removed, no layout shift. */
  removing?: readonly string[]
}

export const MountedProjectsRow: FC<MountedProjectsRowProps> = ({
  mounted,
  onUnmount,
  removing = [],
}) => {
  const t = useTranslations('chat')

  // Nothing in view is not an empty row, it is no row: the composer's vertical
  // budget on a phone is the whole reason the tree exists behind a chip.
  if (mounted.length === 0) return null

  return (
    <div
      className="flex min-w-0 items-center gap-2"
      data-testid="mounted-projects-row"
      aria-label={t('workspace.mounted.aria', {
        names: mounted.map((project) => project.projectName).join(', '),
      })}
    >
      <SectionLabel className="shrink-0">{t('workspace.mounted.label')}</SectionLabel>
      {/* Horizontal overflow at five chips on a phone. `scroll-fade-right` is a
          MASK, not a gradient overlay — it composites against whatever surface
          the row sits on — and it never claims the page's vertical pan. */}
      <div className="scroll-fade-right scrollbar-hide flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {mounted.map((project) => {
          const isRemoving = removing.includes(project.projectId)
          return (
            <span
              key={project.projectId}
              className={cn(
                'duration-quick flex h-6 shrink-0 items-center gap-1 rounded-full border pl-2.5 pr-1 text-xs font-medium transition-opacity ease-out motion-reduce:transition-none',
                isRemoving && 'opacity-60'
              )}
              style={sourceSignalStyle('project')}
              data-testid="mounted-project-chip"
            >
              <FolderKanban className="size-3 shrink-0" aria-hidden="true" />
              <span className="max-w-40 truncate">{project.projectName}</span>
              <button
                type="button"
                onClick={() => onUnmount(project.projectId)}
                disabled={isRemoving}
                aria-label={t('workspace.tree.mountRemove', { project: project.projectName })}
                className="focus-visible:ring-ring/60 pointer-coarse:size-8 flex size-4 items-center justify-center rounded-full opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-progress"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          )
        })}
      </div>
    </div>
  )
}
