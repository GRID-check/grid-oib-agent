'use client'

/**
 * Projects-home client island: the header row (page title, client-side name
 * filter, "New project" action), the resume rail, the projects list, and every
 * empty state. The index page stays server-rendered (DB reads, authz, the Archiv
 * entry card, recently-deleted); this component owns only the search state
 * and the `?new=1` auto-open wiring for the create dialog.
 *
 * Shape of the page, and why it is not one uniform card grid any more: the first
 * three projects are the ones this person actually works in, as the usual
 * `ProjectCard`s, and everything else is a dense `ProjectListRow` list. Both are
 * built from the same atoms (`project-atoms.tsx`) — the rail is a selection and
 * an ordering, not a new kind of card. A grid where every project is equally loud reads fine at
 * six and becomes a wall at forty — and the old ordering put the project someone
 * touched ten minutes ago below three they have never opened. The rail is a
 * fixed size regardless of how many projects exist, so the page's shape stops
 * changing once the list starts growing.
 *
 * Searching collapses both sections into one flat result list: with a query on
 * screen, "continue where you left off" is not the question being asked.
 */

import { useMemo, useState } from 'react'
import { FolderOpen, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { SearchField } from '@/components/ui/search-field'
import { SectionLabel } from '@/components/ui/section-label'
import { splitForResume } from '@/features/projects/lib/resume-selection'
import type { Project } from '@/lib/db/schema'
import { useTranslations } from '@/i18n'
import { CreateProjectDialog } from './create-project-dialog'
import { ProjectCard } from './project-card'
import { ProjectListRow } from './project-list-row'

interface ProjectsGridProps {
  projects: Project[]
  /** Ingested document count per project id. */
  docCounts: Record<string, number>
  /** ISO timestamp of the VIEWER's own last activity, keyed by project id. */
  viewerActivity?: Record<string, string>
  /** Open the create dialog on mount — wired to `/app/projects?new=1`. */
  autoOpenCreate?: boolean
}

/**
 * Section eyebrow with an optional count beside it.
 *
 * Both pieces come from the primitives — `SectionLabel` for the ~10.5px
 * uppercase eyebrow, `CountPill` for the quiet number next to a heading. This
 * wrapper is only the arrangement of the two. It briefly hand-rolled both, at
 * nearly double the documented tracking and with the count dimmed to
 * `text-muted-foreground/70` — about 2.2:1 on paper, which is not a hierarchy
 * signal, it is an unreadable number. The pill's fill does that job at full
 * contrast instead.
 */
function SectionHeading({ id, children, count }: { id: string; children: string; count?: number }): JSX.Element {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <SectionLabel as="h2" id={id}>
        {children}
      </SectionLabel>
      {count !== undefined && <CountPill>{count}</CountPill>}
    </div>
  )
}

export function ProjectsGrid({
  projects,
  docCounts,
  viewerActivity = {},
  autoOpenCreate = false,
}: ProjectsGridProps): JSX.Element {
  const t = useTranslations('projects')
  const [query, setQuery] = useState('')

  const needle = query.trim().toLowerCase()
  const isSearching = needle.length > 0

  const filtered = useMemo(() => {
    if (!needle) return projects
    return projects.filter((project) => project.name.toLowerCase().includes(needle))
  }, [projects, needle])

  // One helper serves both modes: zero rail slots turns the split into "order
  // everything by recency", which is exactly what a result list wants too.
  const { resume, rest, basis } = useMemo(
    () => splitForResume(filtered, viewerActivity, isSearching ? 0 : undefined),
    [filtered, viewerActivity, isSearching],
  )

  const hasProjects = projects.length > 0

  const renderRow = (project: Project): JSX.Element => (
    <ProjectListRow
      key={project.id}
      project={project}
      docCount={docCounts[project.id] ?? 0}
      activityAt={viewerActivity[project.id]}
    />
  )

  return (
    <div>
      <PageHeader
        className="min-h-9 sm:items-center"
        title={t('list.heading')}
        action={
          <div className="flex w-full items-center gap-2.5 sm:w-auto">
            {hasProjects && (
              // The one search molecule — magnifier + input with the phone
              // keyboard already told what Enter does. Its inner field is `h-9`
              // on the canonical `rounded-xl` input, so the header keeps the
              // height the hand-rolled `h-9` field had; `min-h-9` on the header
              // below reserves it either way. No clear control: with none, the
              // molecule renders no clear button, exactly like before.
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder={t('list.searchPlaceholder')}
                label={t('list.searchAria')}
                className="w-full sm:w-64"
              />
            )}
            {/* Primary near-black action — Button default variant consumes --primary. */}
            <CreateProjectDialog defaultOpen={autoOpenCreate} />
          </div>
        }
      />

      <div className="mt-7">
        {!hasProjects ? (
          <EmptyState
            icon={FolderOpen}
            title={t('list.empty.title')}
            description={t('list.empty.description')}
            action={<CreateProjectDialog label={t('list.empty.action')} />}
            className="min-h-96 justify-center"
          />
        ) : isSearching ? (
          rest.length === 0 ? (
            <EmptyState
              variant="bare"
              icon={Search}
              title={t('list.noMatch.title')}
              description={t('list.noMatch.description')}
              action={
                <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                  {t('list.noMatch.clear')}
                </Button>
              }
            />
          ) : (
            <section aria-labelledby="projects-results" className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
              <SectionHeading id="projects-results" count={rest.length}>
                {t('list.results.heading')}
              </SectionHeading>
              {/* `space-y-1`: the rows are full-border rounded pills now, so they
                  take a 4px gap rather than touching and doubling the seam. */}
              <ul className="-mx-3 space-y-1">{rest.map(renderRow)}</ul>
            </section>
          )
        ) : (
          // `gap-8` is the documented gap between major sections; whitespace
          // does the separating, so neither heading needs a rule under it.
          <div className="flex flex-col gap-8 animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
            <section aria-labelledby="projects-resume">
              <SectionHeading id="projects-resume">
                {basis === 'activity' ? t('list.resume.heading') : t('list.resume.fallbackHeading')}
              </SectionHeading>
              {/* The staple project card, unchanged — the rail is a selection
                  and an ordering, not a new kind of card. */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
                {resume.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    docCount={docCounts[project.id] ?? 0}
                    activityAt={viewerActivity[project.id]}
                  />
                ))}
              </div>
            </section>

            {rest.length > 0 && (
              <section aria-labelledby="projects-more">
                {/* "More projects", not "All projects": this list is everything
                    MINUS the rail, so an "all" heading would sit above a count
                    that disagrees with the page. */}
                <SectionHeading id="projects-more" count={rest.length}>
                  {t('list.more.heading')}
                </SectionHeading>
                <ul className="-mx-3 space-y-1">{rest.map(renderRow)}</ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
