import { render, screen } from '@/test-utils'
import { describe, test, expect } from 'vitest'
import { ProjectCard } from './project-card'
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

  test('shows a document count and links to the project overview', () => {
    render(<ProjectCard project={createProject({ id: 'proj-abc', name: 'Beta' })} docCount={3} />)

    expect(screen.getByText('3 documents')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open beta/i })).toHaveAttribute(
      'href',
      '/app/projects/proj-abc',
    )
  })
})
