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

  test('puts the three projects the viewer worked in most recently on the rail, the rest in the list', () => {
    render(
      <ProjectsGrid
        projects={[
          createProject({ id: 'p1', name: 'Seestadt' }),
          createProject({ id: 'p2', name: 'Grinzing' }),
          createProject({ id: 'p3', name: 'Lände 3' }),
          createProject({ id: 'p4', name: 'Semmering' }),
          createProject({ id: 'p5', name: 'Floridsdorf' }),
        ]}
        docCounts={{}}
        viewerActivity={{
          p4: '2026-08-03T09:00:00Z',
          p2: '2026-08-05T09:00:00Z',
          p1: '2026-08-04T09:00:00Z',
        }}
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Pick up where you left off' })).toBeInTheDocument()

    // The rail is the only place with headings; the list is <li> rows.
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual([
      'Grinzing',
      'Seestadt',
      'Semmering',
    ])
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('heading', { level: 2, name: 'More projects' })).toBeInTheDocument()
  })

  test('fills the rail with any three projects, and says so, when the viewer has no activity', () => {
    render(
      <ProjectsGrid
        projects={[
          createProject({ id: 'p1', name: 'Older', createdAt: new Date('2026-01-01T00:00:00Z') }),
          createProject({ id: 'p2', name: 'Newer', createdAt: new Date('2026-05-01T00:00:00Z') }),
        ]}
        docCounts={{}}
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Your projects' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pick up where you left off' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual([
      'Newer',
      'Older',
    ])
    // Fewer projects than rail slots — no list section at all.
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  test('collapses the rail into a single result list while searching', async () => {
    render(
      <ProjectsGrid
        projects={[
          createProject({ id: 'p1', name: 'Wohnbau Seestadt' }),
          createProject({ id: 'p2', name: 'Wohnbau Linz' }),
          createProject({ id: 'p3', name: 'Betriebsbau Graz' }),
          createProject({ id: 'p4', name: 'Hotel Semmering' }),
        ]}
        docCounts={{}}
        viewerActivity={{ p1: '2026-08-05T09:00:00Z' }}
      />,
    )

    await userEvent.type(screen.getByRole('textbox', { name: /search projects/i }), 'wohnbau')

    expect(screen.getByRole('heading', { level: 2, name: 'Matches' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pick up where you left off' })).not.toBeInTheDocument()
    // Both matches are rows, including the one that was on the rail a moment ago.
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
  })
})
