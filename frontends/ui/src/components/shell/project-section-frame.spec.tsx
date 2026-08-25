import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen } from '@/test-utils'
import { ProjectSectionActions, ProjectSectionFrame } from './project-section-frame'

let pathname = '/app/projects/p1/history'

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}))

beforeEach(() => {
  pathname = '/app/projects/p1/history'
})

describe('ProjectSectionFrame', () => {
  test('opens the section with its heading and nothing above it', () => {
    render(
      <ProjectSectionFrame projectId="p1" projectName="Stadthaus Wien">
        <p>history body</p>
      </ProjectSectionFrame>,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'History' })).toBeInTheDocument()
    // The header is one line: no trail back to the project, and no subtitle
    // restating what the heading and the rail already say.
    expect(screen.queryByRole('navigation', { name: 'breadcrumb' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Stadthaus Wien' })).not.toBeInTheDocument()
    expect(screen.queryByText(/deep-research run/i)).not.toBeInTheDocument()
    expect(screen.getByText('history body')).toBeInTheDocument()
  })

  test('renders children only on the chat route — no page heading', () => {
    pathname = '/app/projects/p1/chat'
    render(
      <ProjectSectionFrame projectId="p1" projectName="Stadthaus Wien">
        <p>chat body</p>
      </ProjectSectionFrame>,
    )

    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Stadthaus Wien' })).not.toBeInTheDocument()
    expect(screen.getByText('chat body')).toBeInTheDocument()
  })

  test('places ProjectSectionActions in the header', () => {
    pathname = '/app/projects/p1/skills'
    render(
      <ProjectSectionFrame projectId="p1" projectName="Stadthaus Wien">
        <ProjectSectionActions>
          <button type="button">New skill</button>
        </ProjectSectionActions>
        <p>skills body</p>
      </ProjectSectionFrame>,
    )

    const action = screen.getByRole('button', { name: 'New skill' })
    const heading = screen.getByRole('heading', { level: 1, name: 'Skills' })
    expect(heading.closest('header')).toContainElement(action)
  })
})
