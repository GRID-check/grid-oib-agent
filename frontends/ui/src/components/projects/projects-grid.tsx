'use client'

/**
 * Projects-home client island: the header row (page title, client-side name
 * filter, "New project" action), the responsive card grid, and both empty
 * states. The index page stays server-rendered (DB reads, authz, the Archiv
 * entry card, recently-deleted); this component owns only the search state
 * and the `?new=1` auto-open wiring for the create dialog.
 */

import { useMemo, useState } from 'react'
import { FolderOpen, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import type { Project } from '@/lib/db/schema'
import { useTranslations } from '@/i18n'
import { CreateProjectDialog } from './create-project-dialog'
import { ProjectCard } from './project-card'

interface ProjectsGridProps {
  projects: Project[]
  /** Ingested document count per project id. */
  docCounts: Record<string, number>
  /** Open the create dialog on mount — wired to `/app/projects?new=1`. */
  autoOpenCreate?: boolean
}

export function ProjectsGrid({ projects, docCounts, autoOpenCreate = false }: ProjectsGridProps): JSX.Element {
  const t = useTranslations('projects')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return projects
    return projects.filter((project) => project.name.toLowerCase().includes(needle))
  }, [projects, query])

  const hasProjects = projects.length > 0

  return (
    <div>
      <PageHeader
        className="min-h-9 flex-col items-start sm:flex-row sm:items-center"
        title={t('list.heading')}
        action={
          <div className="flex w-full items-center gap-2.5 sm:w-auto">
            {hasProjects && (
              <div className="relative w-full sm:w-64">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('list.searchPlaceholder')}
                  aria-label={t('list.searchAria')}
                  className="h-9 rounded-md pl-9"
                />
              </div>
            )}
            {/* Primary near-black action — Button default variant consumes --primary. */}
            <CreateProjectDialog defaultOpen={autoOpenCreate} />
          </div>
        }
      />

      <section className="mt-7">
        {!hasProjects ? (
          <EmptyState
            icon={FolderOpen}
            title={t('list.empty.title')}
            description={t('list.empty.description')}
            action={<CreateProjectDialog label={t('list.empty.action')} />}
            className="min-h-96 justify-center"
          />
        ) : filtered.length === 0 ? (
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
          <div className="grid grid-cols-1 gap-6 animate-in fade-in-0 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((project) => (
              <ProjectCard key={project.id} project={project} docCount={docCounts[project.id] ?? 0} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
