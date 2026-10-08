/**
 * The projects list's status filter (ADR-0089): active, closed, or all.
 *
 * Every member reads every closed project, so an office's list grows by every
 * project it ever finished. The list opens on the active ones; the closed ones
 * are one click away. A person with no active project at all opens on all of
 * them, rather than on an empty list.
 */

import type { Project } from '@/lib/db/schema'

export const PROJECT_STATUS_FILTERS = ['active', 'closed', 'all'] as const
export type ProjectStatusFilter = (typeof PROJECT_STATUS_FILTERS)[number]

export function isProjectStatusFilter(value: string): value is ProjectStatusFilter {
  return (PROJECT_STATUS_FILTERS as readonly string[]).includes(value)
}

export function filterProjectsByStatus<P extends Pick<Project, 'status'>>(projects: readonly P[], filter: ProjectStatusFilter): P[] {
  if (filter === 'all') return [...projects]
  return projects.filter((project) => (project.status === 'closed') === (filter === 'closed'))
}

export function defaultProjectStatusFilter(projects: readonly Pick<Project, 'status'>[]): ProjectStatusFilter {
  return projects.some((project) => project.status !== 'closed') ? 'active' : 'all'
}

export function countByStatus(projects: readonly Pick<Project, 'status'>[]): Record<ProjectStatusFilter, number> {
  const closed = projects.filter((project) => project.status === 'closed').length
  return { active: projects.length - closed, closed, all: projects.length }
}
