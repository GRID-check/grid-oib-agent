import type { ReactNode } from 'react'
import { render, screen } from '@/test-utils'
import { vi, describe, test, expect } from 'vitest'
import { ProjectSettings } from './project-settings'
import type { ProjectOverviewData } from '../types'

// The page is pure composition — the reused sections have their own specs, so
// they are stubbed here and we assert what gets mounted (and gated) for whom.
vi.mock('./project-brief', () => ({
  ProjectBrief: () => <div data-testid="project-brief" />,
}))
vi.mock('./applicable-standards', () => ({
  ApplicableStandards: () => <div data-testid="applicable-standards" />,
}))
vi.mock('./project-memory-panel', () => ({
  ProjectMemoryPanel: () => <div data-testid="project-memory-panel" />,
}))
vi.mock('./project-danger-zone', () => ({
  ProjectDangerZone: () => <div data-testid="project-danger-zone" />,
}))
vi.mock('./project-rename-button', () => ({
  ProjectRenameButton: () => <button data-testid="project-rename-button" />,
}))
vi.mock('@/components/projects/project-members-form', () => ({
  ProjectMembersForm: (props: { projectId: string; canManage: boolean }) => (
    <div data-testid="project-members-form" data-can-manage={String(props.canManage)} />
  ),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

// The real portal lands in the layout header; unit tests have no slot.
vi.mock('@/components/shell/project-section-frame', () => ({
  ProjectSectionActions: ({ children }: { children: ReactNode }) => children,
}))

const data: ProjectOverviewData = {
  id: 'p1',
  name: 'Alpine Tower',
  collectionName: 'proj_1',
  createdAt: '2026-07-01T10:00:00Z',
  profileDisplay: null,
  profile: null,
  applicableStandards: [],
  briefComplete: false,
  documentCount: 0,
  totalFileSize: 0,
  recentDocuments: [],
}

describe('ProjectSettings', () => {
  test('composes parameters, members, memory and the honest insights empty state', () => {
    render(<ProjectSettings data={data} />)

    // The name is a content identity line, not a second page title.
    expect(screen.getByText('Alpine Tower')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    // The single project-profile surface is the brief (facts, summary, gaps),
    // not a duplicate parameters card.
    expect(screen.getByTestId('project-brief')).toBeInTheDocument()
    expect(screen.getByTestId('applicable-standards')).toBeInTheDocument()
    expect(screen.getByTestId('project-members-form')).toBeInTheDocument()
    expect(screen.getByTestId('project-memory-panel')).toBeInTheDocument()
    // Insights promise nothing: no numbers, just the empty state.
    expect(screen.getByText('No insights yet')).toBeInTheDocument()
  })

  test('viewers get a read-only page: no rename, no danger zone, read-only roster', () => {
    render(<ProjectSettings data={data} canManageProject={false} />)

    expect(screen.queryByTestId('project-rename-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-danger-zone')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-members-form')).toHaveAttribute('data-can-manage', 'false')
  })

  test('project admins get rename, managing roster and the danger zone', () => {
    render(<ProjectSettings data={data} canManageProject />)

    expect(screen.getByTestId('project-rename-button')).toBeInTheDocument()
    expect(screen.getByTestId('project-danger-zone')).toBeInTheDocument()
    expect(screen.getByTestId('project-members-form')).toHaveAttribute('data-can-manage', 'true')
  })

  test('links to the flagged knowledge page only when enabled', () => {
    const { rerender } = render(<ProjectSettings data={data} />)
    expect(screen.queryByRole('link', { name: /knowledge base/i })).not.toBeInTheDocument()

    rerender(<ProjectSettings data={data} showKnowledgeLink />)
    expect(screen.getByRole('link', { name: /knowledge base/i })).toHaveAttribute(
      'href',
      '/app/projects/p1/knowledge'
    )
  })
})
