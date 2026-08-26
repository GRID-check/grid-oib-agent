import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
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
  default: forwardRef<
    HTMLAnchorElement,
    { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>
  >(function MockLink({ href, children, ...rest }, ref) {
    return (
      <a ref={ref} href={href} {...rest}>
        {children}
      </a>
    )
  }),
}))

// The real portal lands in the layout header; unit tests have no slot.
vi.mock('@/components/shell/project-section-frame', () => ({
  ProjectSectionActions: ({ children }: { children: ReactNode }) => children,
}))

const conversation = (
  id: string,
  title: string | null,
  updatedAt: string,
  tags: string[] = []
) => ({
  id,
  title,
  tags,
  updatedAt,
  createdAt: updatedAt,
})

const typeChip = (name: string): HTMLElement => screen.getByRole('radio', { name })

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

    await userEvent.type(
      screen.getByRole('textbox', { name: /search conversations/i }),
      'stellplatz'
    )

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
      expect.objectContaining({ projectId: 'p1', projectCollection: 'proj_1' })
    )
  })

  test('type chips scope the page to conversations or research runs (honest item-type signal)', async () => {
    listConversations.mockResolvedValue([
      conversation('c1', 'Brandschutz EG', '2026-07-15T10:00:00Z'),
    ])
    render(<ProjectHistory projectId="p1" projectCollection="proj_1" />)
    await screen.findByText('Brandschutz EG')

    // Exclusive type chips are a radiogroup. Default "All" shows both sections
    // and the visible section labels.
    expect(screen.getByTestId('research-runs-list')).toBeInTheDocument()
    const all = typeChip('All')
    expect(all).toHaveAttribute('data-state', 'on')
    expect(all).toHaveAttribute('aria-checked', 'true')
    expect(typeChip('Conversations')).toHaveAttribute('aria-checked', 'false')
    expect(typeChip('Deep research')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('heading', { name: 'Conversations' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Deep research' })).toBeInTheDocument()

    await userEvent.click(typeChip('Deep research'))
    expect(screen.queryByText('Brandschutz EG')).not.toBeInTheDocument()
    expect(screen.getByTestId('research-runs-list')).toBeInTheDocument()
    const research = typeChip('Deep research')
    expect(research).toHaveAttribute('data-state', 'on')
    expect(research).toHaveAttribute('aria-checked', 'true')
    expect(typeChip('All')).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByRole('heading', { name: 'Conversations' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Deep research' })).not.toBeInTheDocument()

    await userEvent.click(typeChip('Conversations'))
    expect(await screen.findByText('Brandschutz EG')).toBeInTheDocument()
    expect(screen.queryByTestId('research-runs-list')).not.toBeInTheDocument()
    const conversations = typeChip('Conversations')
    expect(conversations).toHaveAttribute('data-state', 'on')
    expect(conversations).toHaveAttribute('aria-checked', 'true')
  })

  test('topic chips OR-filter conversations; Clear resets the selection', async () => {
    listConversations.mockResolvedValue([
      conversation('c1', 'Brandschutz EG', '2026-07-15T10:00:00Z', ['brandschutz']),
      conversation('c2', 'Stellplatz Nachweis', '2026-07-14T10:00:00Z', ['energie']),
    ])
    render(<ProjectHistory projectId="p1" projectCollection="proj_1" />)
    await screen.findByText('Brandschutz EG')

    const fire = screen.getByRole('button', { name: 'Fire safety' })
    expect(fire).toHaveAttribute('data-state', 'off')
    await userEvent.click(fire)
    expect(fire).toHaveAttribute('data-state', 'on')
    expect(fire).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Stellplatz Nachweis')).not.toBeInTheDocument()
    expect(screen.getByText('Brandschutz EG')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByText('Stellplatz Nachweis')).toBeInTheDocument()
    expect(fire).toHaveAttribute('data-state', 'off')
  })
})
