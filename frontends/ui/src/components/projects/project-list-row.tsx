'use client'

/**
 * One row of the projects list — everything below the resume rail on
 * projects-home.
 *
 * A different ARRANGEMENT of the project card, not a different component: every
 * part here comes from `project-atoms.tsx`, the same atoms `ProjectCard` is
 * assembled from, so the name, the brief, the status chip, the timestamp rule
 * and the settings gear behave identically in both. Only the layout differs —
 * card material spread into a row, with the meta moved into right-aligned
 * tabular columns. See `docs/design/project-surfaces.md`.
 *
 * Why a row at all: past a dozen projects a card grid stops being a set of
 * objects and becomes a wall — nothing is ranked, every tile costs the same
 * attention, and finding a name means reading all of them. The row spends the
 * density it wins on the two things a scan needs: a fixed left edge to index by
 * (the initials tile) and columns that line up down the page.
 */

import type { Project } from '@/lib/db/schema'
import {
  ProjectActivity,
  ProjectDocCount,
  ProjectInitialsTile,
  ProjectOpenLink,
  ProjectSettingsLink,
  ProjectSummaryLine,
} from './project-atoms'
import { getProjectStatus, ProjectStatusChip } from './project-status'

interface ProjectListRowProps {
  project: Project
  /** Number of documents ingested into the project corpus. */
  docCount?: number
  /** ISO timestamp of the VIEWER's own last activity, when they have any. */
  activityAt?: string
}

export function ProjectListRow({ project, docCount = 0, activityAt }: ProjectListRowProps): JSX.Element {
  const status = getProjectStatus(project)

  return (
    // The row's resting state is the paper itself with a hairline under it; on
    // hover it becomes the card surface, so a row and a card are the same
    // material caught in two states rather than two different things.
    <li className="group relative flex items-center gap-3 rounded-xl border-b border-border px-3 py-2.5 transition-[background-color,box-shadow,border-color] duration-200 ease-out last:border-b-0 hover:border-transparent hover:bg-card hover:shadow-xs has-[a:focus-visible]:border-transparent has-[a:focus-visible]:bg-card motion-reduce:transition-none">
      <ProjectInitialsTile project={project} />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          <ProjectOpenLink project={project} />
        </span>
        <ProjectSummaryLine project={project} className="mt-0.5 block text-xs" />
      </span>

      <span className="hidden shrink-0 md:block">
        <ProjectStatusChip status={status} />
      </span>

      <ProjectDocCount count={docCount} className="hidden w-[104px] shrink-0 justify-end lg:flex" />

      {/* The one meta column that survives to the narrowest screen: with the
          brief truncated and the chips gone, "when was I last in this" is what
          is left to choose a row by. */}
      <ProjectActivity
        project={project}
        activityAt={activityAt}
        showLabel={false}
        className="w-[72px] shrink-0 text-right sm:w-[104px]"
      />

      <ProjectSettingsLink project={project} className="shrink-0" />
    </li>
  )
}
