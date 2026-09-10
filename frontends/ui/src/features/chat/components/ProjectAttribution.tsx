'use client'

/**
 * WHICH project a citation came from — "Projekt Seestadt Nord", above the
 * filename (`workspace-chat-ui.md` §4).
 *
 * In a project chat the shelf was the whole answer: there was one project, and
 * "Projektwissen" named it by standing in it. In the Büro several mounted
 * projects are readable in one turn, so a green chip that says only
 * "Projektwissen" has stopped attributing anything. This line is what the shelf
 * used to imply, said out loud.
 *
 * ## It renders only where it is a fact the reader does not already have
 *
 * Suppressed in a project chat: naming the project the reader is standing in is
 * noise, and noise on a provenance surface is worse than silence — it teaches
 * the reader to skim exactly the line they will one day need to read.
 *
 * ## It can never name a project the reader may not open
 *
 * The scope a citation came from was built from readable projects only, and the
 * BFF re-authorizes `project:chat` on every mount. That is a property of the
 * BFF, not of this component, and it is why this component may render a name at
 * all (ADR-0038 — a name is exactly what `listProjects` exists to withhold).
 */

import { type FC } from 'react'
import { ArrowRight, FolderKanban } from 'lucide-react'

import { useTranslations } from '@/i18n'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import type { Shelf } from '../lib/source-kinds'

export interface ProjectAttributionProps {
  projectId?: string
  projectName?: string
  /** Only `project` and `register` rows are attributable to a project. */
  shelf?: Shelf
  /** False in a project chat, where the project is the room the reader is in. */
  show: boolean
  /**
   * Carry the reader's question into that project's chat. Absent when there is
   * nothing to carry, or when the caller has no navigation to offer.
   */
  onContinueInProject?: () => void
}

/**
 * Shelves whose passages belong to one project.
 *
 * `register` is here because a Steckbrief is an assertion ABOUT a project — the
 * one row whose provenance is a project without being a document from inside
 * one — and in the Büro it is the shelf a reader is likeliest to meet first
 * (§7, flow c). Every other shelf belongs to nobody in particular, and a
 * project name on one of them would be a claim nothing carried.
 */
const ATTRIBUTABLE: readonly Shelf[] = ['project', 'register']

export const ProjectAttribution: FC<ProjectAttributionProps> = ({
  projectId,
  projectName,
  shelf,
  show,
  onContinueInProject,
}) => {
  const t = useTranslations('chat')
  if (!show || !projectId || !projectName) return null
  if (!shelf || !ATTRIBUTABLE.includes(shelf)) return null

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid="project-attribution"
    >
      {/* Icon, label and colour travel together, as they do on every other
          provenance surface: the chip is green AND says the project's name AND
          shows `FolderKanban`, so nobody has to read a hue (§6). */}
      <SourceSignalChip signal="project" icon={FolderKanban}>
        {/* A Steckbrief names itself first and the project second — it is a
            different GRAIN of the same trust tier, not a document from inside
            the project, and reading "Projekt Seestadt" on a profile fact would
            promise a file that was never opened. */}
        {shelf === 'register'
          ? `${t('workspace.attribution.register')} · ${projectName}`
          : t('workspace.attribution.project', { project: projectName })}
      </SourceSignalChip>
      {onContinueInProject && (
        <button
          type="button"
          onClick={onContinueInProject}
          data-citation-continue=""
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium hover:underline"
        >
          {t('workspace.attribution.continueInProject')}
          <ArrowRight aria-hidden="true" className="size-3" />
        </button>
      )}
    </div>
  )
}
