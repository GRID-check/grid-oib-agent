import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect } from 'vitest'
import { ProjectsGrid } from './projects-grid'
import type { Project } from '@/lib/db/schema'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects',
}))

// The create dialog pulls in a server action via its form; grid behaviour
// under test does not depend on it.
vi.mock('./create-project-form', () => ({
  CreateProjectForm: () => <div data-testid="create-project-form" />,
}))

const createProject = (overrides: Partial<Project> = {}): Project =>
  ({
    id: 'proj-1',
    organizationId: 'org-1',
    name: 'Alpha Project',
    collectionName: 'proj_alpha',
    createdBy: 'user-1',
    workosResourceId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }) as Project

describe('ProjectsGrid', () => {
  test('renders the header row with title, search, and the New project action', () => {
    render(
      <ProjectsGrid
        projects={[createProject()]}
        docCounts={{}}
      />,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /search projects/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument()
  })

  test('filters the grid client-side by name and can clear a no-match search', async () => {
    render(
      <ProjectsGrid
        projects={[
          createProject({ id: 'p1', name: 'Wohnbau Seestadt' }),
          createProject({ id: 'p2', name: 'Betriebsbau Linz' }),
        ]}
        docCounts={{}}
      />,
    )

    const search = screen.getByRole('textbox', { name: /search projects/i })
    await userEvent.type(search, 'seestadt')
    expect(screen.getByText('Wohnbau Seestadt')).toBeInTheDocument()
    expect(screen.queryByText('Betriebsbau Linz')).not.toBeInTheDocument()

    await userEvent.clear(search)
    await userEvent.type(search, 'zzz-no-such-project')
    expect(screen.getByText('No matching projects')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /clear search/i }))
    expect(screen.getByText('Wohnbau Seestadt')).toBeInTheDocument()
    expect(screen.getByText('Betriebsbau Linz')).toBeInTheDocument()
  })

  test('shows the first-project empty state (no search field) when there are no projects', () => {
    render(<ProjectsGrid projects={[]} docCounts={{}} />)

    expect(screen.getByText('Start your first project')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /search projects/i })).not.toBeInTheDocument()
  })
})
