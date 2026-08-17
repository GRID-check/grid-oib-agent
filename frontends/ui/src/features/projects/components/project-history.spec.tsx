import type { ReactNode } from 'react'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ProjectHistory } from './project-history'

const listConversations = vi.fn()

vi.mock('@/adapters/api/conversations-client', () => ({
  conversationsClient: {
    list: (...args: unknown[]) => listConversations(...args),
  },
}))

// The research section is ResearchRunsList reused wholesale — it has its own
// spec; here we only assert it is mounted with the right scoping props.
const researchRunsListProps = vi.fn()
vi.mock('./research-runs-list', () => ({
  ResearchRunsList: (props: Record<string, unknown>) => {
    researchRunsListProps(props)
    return <div data-testid="research-runs-list" />
  },
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

// The real portal lands in the layout header; unit tests have no slot.
vi.mock('@/components/shell', () => ({
  ProjectSectionActions: ({ children }: { children: ReactNode }) => children,
}))

const conversation = (id: string, title: string | null, updatedAt: string) => ({
  id,
  title,
  updatedAt,
  createdAt: updatedAt,
})

describe('ProjectHistory', () => {
  beforeEach(() => {
    listConversations.mockReset()
    researchRunsListProps.mockClear()
  })

  test('lists conversations newest-first with ?session= deep links into chat', async () => {
    listConversations.mockResolvedValue([
      conversation('c-old', 'Fluchtweg OG2', '2026-07-01T10:00:00Z'),
      conversation('c-new', 'Brandschutz EG', '2026-07-15T10:00:00Z'),
    ])
    render(<ProjectHistory projectId="p1" projectCollection="proj_1" />)

    const newLink = await screen.findByRole('link', { name: /Brandschutz EG/ })
    expect(newLink).toHaveAttribute('href', '/app/projects/p1/chat?session=c-new')
    const links = screen.getAllByRole('link', { name: /open conversation/i })
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/app/projects/p1/chat?session=c-new',
      '/app/projects/p1/chat?session=c-old',
    ])
  })

  test('falls back to an untitled label for conversations without a title', async () => {
    listConversations.mockResolvedValue([conversation('c1', null, '2026-07-15T10:00:00Z')])
    render(<ProjectHistory projectId="p1" projectCollection="proj_1" />)

    expect(await screen.findByText('Untitled conversation')).toBeInTheDocument()
  })

  test('search filters the list by title, client-side', async () => {
    listConversations.mockResolvedValue([
      conversation('c1', 'Brandschutz EG', '2026-07-15T10:00:00Z'),
      conversation('c2', 'Stellplatz Nachweis', '2026-07-14T10:00:00Z'),
    ])
    render(<ProjectHistory projectId="p1" projectCollection="proj_1" />)
    await screen.findByText('Brandschutz EG')

    await userEvent.type(screen.getByRole('textbox', { name: /search conversations/i }), 'stellplatz')

    expect(screen.queryByText('Brandschutz EG')).not.toBeInTheDocument()
    expect(screen.getByText('Stellplatz Nachweis')).toBeInTheDocument()

    await userEvent.type(screen.getByRole('textbox', { name: /search conversations/i }), 'xyz')
    expect(await screen.findByText('No matching conversations')).toBeInTheDocument()
  })

  test('renders an honest empty state pointing to chat when there are no conversations', async () => {
    listConversations.mockResolvedValue([])
    render(<ProjectHistory projectId="p1" projectCollection="proj_1" />)

    expect(await screen.findByText('No conversations yet')).toBeInTheDocument()
    const cta = screen.getByRole('link', { name: 'Open chat' })
    expect(cta).toHaveAttribute('href', '/app/projects/p1/chat')
  })

  test('surfaces a retryable error state when the list fails to load', async () => {
    listConversations.mockRejectedValueOnce(new Error('boom'))
    listConversations.mockResolvedValueOnce([
      conversation('c1', 'Brandschutz EG', '2026-07-15T10:00:00Z'),
    ])
    render(<ProjectHistory projectId="p1" projectCollection="proj_1" />)

    expect(await screen.findByText('Conversations could not be loaded')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Brandschutz EG')).toBeInTheDocument()
  })

  test('mounts the server-truth research-runs section scoped to the project collection (FB-10)', async () => {
    listConversations.mockResolvedValue([])
    render(<ProjectHistory projectId="p1" projectCollection="proj_1" />)

    expect(await screen.findByTestId('research-runs-list')).toBeInTheDocument()
    expect(researchRunsListProps).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', projectCollection: 'proj_1' }),
    )
  })

  test('type chips scope the page to conversations or research runs (honest item-type signal)', async () => {
    listConversations.mockResolvedValue([
      conversation('c1', 'Brandschutz EG', '2026-07-15T10:00:00Z'),
    ])
    render(<ProjectHistory projectId="p1" projectCollection="proj_1" />)
    await screen.findByText('Brandschutz EG')

    // Default "All": both the conversation list and the research section show.
    expect(screen.getByTestId('research-runs-list')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Deep research' }))
    expect(screen.queryByText('Brandschutz EG')).not.toBeInTheDocument()
    expect(screen.getByTestId('research-runs-list')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Conversations' }))
    expect(await screen.findByText('Brandschutz EG')).toBeInTheDocument()
    expect(screen.queryByTestId('research-runs-list')).not.toBeInTheDocument()
  })
})
