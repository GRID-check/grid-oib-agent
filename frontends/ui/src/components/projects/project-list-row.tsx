'use client'

/**
 * One row of the projects list — everything below the resume rail on
 * projects-home.
 *
 * A different ARRANGEMENT of the project card, not a different component: every
 * part here comes from `project-atoms.tsx`, the same atoms `ProjectCard` is
 * assembled from, so the name, the brief, the timestamp rule and the settings
 * gear behave identically in both. Only the layout differs — card material
 * spread into a row, with the meta moved into right-aligned tabular columns.
 * See `docs/design/project-surfaces.md`.
 *
 * Why a row at all: past a dozen projects a card grid stops being a set of
 * objects and becomes a wall — nothing is ranked, every tile costs the same
 * attention, and finding a name means reading all of them. The row spends the
 * density it wins on the two things a scan needs: a fixed left edge to index by
 * (the initials tile) and columns that line up down the page.
 *
 * What the row deliberately does NOT carry is the status chip. `getProjectStatus`
 * can only return `active` — so on a list it is the same tinted chip on every
 * row, a solid band of chroma reading as the loudest thing on the page while
 * carrying no information at all. It stays on the card, where it is one chip
 * among few. It belongs here the day the data model grows a second status.
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

interface ProjectListRowProps {
  project: Project
  /** Number of documents ingested into the project corpus. */
  docCount?: number
  /** ISO timestamp of the VIEWER's own last activity, when they have any. */
  activityAt?: string
}

export function ProjectListRow({ project, docCount = 0, activityAt }: ProjectListRowProps): JSX.Element {
  return (
    // Full-border `rounded-lg` pill on the paper, matching `ItemList` — the old
    // `rounded-xl + border-b + hover:border-transparent` left the rounded
    // corners orphaned over the hairline and flipped three properties on hover
    // (border, background, shadow). Now the border stands still and hover lifts
    // one property plus the background. `px-3 py-2.5` untouched: row height does
    // not move.
    <li className="group relative flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 transition-[background-color,box-shadow] duration-quick ease-out hover:bg-card hover:shadow-xs has-[a:focus-visible]:bg-card motion-reduce:transition-none">
      {/* Hidden on phones: indexing a single narrow column by initials is worth
          less than the 48px it takes from names that are already truncating. */}
      <ProjectInitialsTile project={project} className="hidden sm:grid" />

      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          <ProjectOpenLink project={project} />
        </span>
        <ProjectSummaryLine project={project} fallback={false} className="mt-0.5" />
      </div>

      {/* Left-aligned inside its fixed column: right-aligning an icon+text pair
          whose text width varies ("1 document" … "24 documents") staggers the
          ICON, which is the thing the eye actually indexes the column by. The
          ragged edge falls on the word instead, where nobody is scanning. */}
      <ProjectDocCount count={docCount} className="hidden w-[104px] shrink-0 lg:flex" />

      {/* The one meta column that survives to the narrowest screen: with the
          brief truncated and the tile gone, "when was I last in this" is what is
          left to choose a row by. */}
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
