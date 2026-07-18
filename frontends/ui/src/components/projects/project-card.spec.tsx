import { render, screen } from '@/test-utils'
import { describe, test, expect } from 'vitest'
import { ProjectCard } from './project-card'
import { getProjectStatus } from './project-status'
import type { Project } from '@/lib/db/schema'

const createProject = (overrides: Partial<Project> = {}): Project =>
  ({
    id: 'proj-1',
    organizationId: 'org-1',
    name: 'Alpha Project',
    collectionName: 'proj_alpha_collection',
    createdBy: 'user-1',
    workosResourceId: 'res-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }) as Project

describe('ProjectCard', () => {
  test('renders the project name and never leaks the internal collection name', () => {
    render(<ProjectCard project={createProject({ name: 'Alpha', collectionName: 'proj_secret' })} />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('proj_secret')).not.toBeInTheDocument()
  })

  test('links to the project overview', () => {
    // The card face mirrors the click-dummy (name · summary · last activity) and
    // deliberately omits the doc count; docCount stays a no-op prop for callers.
    render(<ProjectCard project={createProject({ id: 'proj-abc', name: 'Beta' })} docCount={3} />)

    expect(screen.getByRole('link', { name: /open beta/i })).toHaveAttribute(
      'href',
      '/app/projects/proj-abc',
    )
  })

  test('carries a per-card settings link to the project settings page', () => {
    render(<ProjectCard project={createProject({ id: 'proj-abc', name: 'Beta' })} />)

    expect(screen.getByRole('link', { name: /settings for beta/i })).toHaveAttribute(
      'href',
      '/app/projects/proj-abc/settings',
    )
  })

  test('shows the Active status chip — the only status the data model supports', () => {
    render(<ProjectCard project={createProject()} />)

    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  test('renders last activity as a relative time from the newest timestamp', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000)
    render(
      <ProjectCard
        project={createProject({
          createdAt: new Date('2026-01-01T00:00:00Z'),
          profileUpdatedAt: twoHoursAgo,
        })}
      />,
    )

    expect(screen.getByText('Last activity')).toBeInTheDocument()
    expect(screen.getByText('2 hours ago')).toBeInTheDocument()
  })
})

describe('getProjectStatus', () => {
  test('is honest about the data: every non-deleted project is active (no fake "Done")', () => {
    expect(getProjectStatus({ deletedAt: null })).toBe('active')
  })
})
