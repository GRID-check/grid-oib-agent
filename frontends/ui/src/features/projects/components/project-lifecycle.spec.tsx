/**
 * The closed project's banner and the close/reopen card (ADR-0090).
 */
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CurrentProjectProvider, type CurrentProject } from '../lib/current-project'
import { ClosedProjectBanner } from './closed-project-banner'
import { ProjectLifecycleCard } from './project-lifecycle-card'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const project = (overrides: Partial<CurrentProject> = {}): CurrentProject => ({
  id: 'p1',
  name: 'Seestadt D12',
  status: 'closed',
  closedAt: '2026-10-06T10:00:00Z',
  readsBecauseClosed: false,
  ...overrides,
})

describe('ClosedProjectBanner', () => {
  test('says the project is closed, since when, and that it is read-only', () => {
    render(
      <CurrentProjectProvider value={project()}>
        <ClosedProjectBanner />
      </CurrentProjectProvider>
    )
    expect(screen.getByText('Closed project · read-only')).toBeInTheDocument()
    expect(screen.getByTestId('closed-project-banner')).toHaveTextContent('Closed on October 6, 2026.')
    expect(screen.getByTestId('closed-project-banner')).not.toHaveTextContent('closed projects are readable by the whole office')
  })

  test('tells someone who reads it only because it is closed why, and that restricted folders stay hidden', () => {
    render(
      <CurrentProjectProvider value={project({ readsBecauseClosed: true })}>
        <ClosedProjectBanner />
      </CurrentProjectProvider>
    )
    expect(screen.getByTestId('closed-project-banner')).toHaveTextContent('Folders with their own access list stay hidden from you.')
  })

  test('renders nothing for an active project, or outside one', () => {
    const { container } = render(
      <CurrentProjectProvider value={project({ status: 'active', closedAt: null })}>
        <ClosedProjectBanner />
      </CurrentProjectProvider>
    )
    expect(container).toBeEmptyDOMElement()
    expect(render(<ClosedProjectBanner />).container).toBeEmptyDOMElement()
  })
})

describe('ProjectLifecycleCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    refresh.mockClear()
  })

  test('closing goes through Ausmisten with the debrief: with nothing chosen, it only closes, and refreshes the page', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/cleanup')) return Response.json({ items: [], considered: 3, aiUsed: true, aiError: null })
      if (url.endsWith('/memory')) return Response.json({ items: [] })
      return Response.json({ status: 'closed' })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectLifecycleCard projectId="p1" status="active" closedAt={null} />)

    await userEvent.click(screen.getByRole('button', { name: 'Close project' }))
    // The dialog asks with the closing debrief, and changes nothing before the confirmation.
    expect(await screen.findByTestId('closing-debrief')).toBeInTheDocument()
    expect(await screen.findByText('Piloti proposes nothing to remove.')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/projects/p1/status', expect.anything())
    await userEvent.click(screen.getByRole('button', { name: 'Close without removing anything' }))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/status',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 'closed' }) })
    )
    expect(refresh).toHaveBeenCalled()
  })

  test('a closed project offers to reopen it', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectLifecycleCard projectId="p1" status="closed" closedAt="2026-10-06T10:00:00Z" />)

    expect(screen.getByText('Closed on October 6, 2026')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reopen project' }))
    expect(screen.queryByTestId('closing-debrief')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/status',
      expect.objectContaining({ body: JSON.stringify({ status: 'active' }) })
    )
  })
})
