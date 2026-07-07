'use client'

/**
 * Client-side projects grid with an instant name filter.
 *
 * The projects index is server-rendered; this island owns only the search
 * state. The filter appears once the workspace has enough projects for
 * scanning the grid to beat scrolling it (desktop-first quality-of-life —
 * it works the same on mobile).
 */

import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import type { Project } from '@/lib/db/schema'
import { useTranslations } from '@/i18n'
import { ProjectCard } from './project-card'

/** Grid capacity of one full row set on xl (3 columns × 2 rows). */
const SEARCH_VISIBILITY_THRESHOLD = 6

interface ProjectsGridProps {
  projects: Project[]
  /** Ingested document count per project id. */
  docCounts: Record<string, number>
}

export function ProjectsGrid({ projects, docCounts }: ProjectsGridProps): JSX.Element {
  const t = useTranslations('projects')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return projects
    return projects.filter((project) => project.name.toLowerCase().includes(needle))
  }, [projects, query])

  const showSearch = projects.length > SEARCH_VISIBILITY_THRESHOLD

  return (
    <div>
      {showSearch && (
        <div className="relative mb-6 w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('list.searchPlaceholder')}
            aria-label={t('list.searchAria')}
            className="pl-9"
          />
        </div>
      )}

      {filtered.length === 0 ? (
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
        <div className="grid grid-cols-1 gap-6 animate-in fade-in-0 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((project) => (
            <ProjectCard key={project.id} project={project} docCount={docCounts[project.id] ?? 0} />
          ))}
        </div>
      )}
    </div>
  )
}
