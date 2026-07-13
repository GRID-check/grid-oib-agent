/**
 * The memory_proposal card lets the user complete an org-scoped memory write the
 * agent's service token can't make. This test proves each action targets the
 * right authenticated route (org vs project), that the project action is hidden
 * without a project in scope, and that "No" writes nothing.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryProposalCard } from './MemoryProposalCard'

// Controllable projectId for the mocked chat store.
let mockProjectId: string | null = 'proj-1'

vi.mock('@/features/chat/store', () => ({
  useChatStore: (selector: (s: { projectId: string | null }) => unknown) =>
    selector({ projectId: mockProjectId }),
}))

interface StubbedFetch {
  fetch: ReturnType<typeof vi.fn>
  posts: Array<{ url: string; body: unknown }>
}

function stubFetch(): StubbedFetch {
  const posts: Array<{ url: string; body: unknown }> = []
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ item: {} }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, posts }
}

const baseProps = {
  title: 'Save this finding?',
  content: 'The firm always uses REI 90 for GK4.',
  kind: 'preference' as const,
  confidence: 'high' as const,
}

describe('MemoryProposalCard', () => {
  beforeEach(() => {
    mockProjectId = 'proj-1'
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the finding content', () => {
    stubFetch()
    render(<MemoryProposalCard {...baseProps} />)
    expect(screen.getByText('The firm always uses REI 90 for GK4.')).toBeInTheDocument()
  })

  it('POSTs to /api/organization/memory on org "Yes" and confirms the org scope', async () => {
    const { posts } = stubFetch()
    const user = userEvent.setup()
    render(<MemoryProposalCard {...baseProps} />)

    await user.click(screen.getByRole('button', { name: 'Yes, remember org-wide' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe('/api/organization/memory')
    expect(posts[0].body).toEqual({ kind: 'preference', content: baseProps.content, confidence: 'high' })
    expect(await screen.findByText(/Saved to organization memory/)).toBeInTheDocument()
  })

  it('POSTs to /api/projects/<id>/memory on "Save to just this project"', async () => {
    const { posts } = stubFetch()
    const user = userEvent.setup()
    render(<MemoryProposalCard {...baseProps} />)

    await user.click(screen.getByRole('button', { name: 'Save to just this project' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe('/api/projects/proj-1/memory')
    expect(posts[0].body).toEqual({ kind: 'preference', content: baseProps.content, confidence: 'high' })
    expect(await screen.findByText(/Saved to this project/)).toBeInTheDocument()
  })

  it('hides the project action when there is no project in scope', () => {
    mockProjectId = null
    stubFetch()
    render(<MemoryProposalCard {...baseProps} />)
    expect(screen.queryByRole('button', { name: 'Save to just this project' })).not.toBeInTheDocument()
    // The org-wide action is still available.
    expect(screen.getByRole('button', { name: 'Yes, remember org-wide' })).toBeInTheDocument()
  })

  it('writes nothing and dismisses on "No"', async () => {
    const { posts } = stubFetch()
    const user = userEvent.setup()
    render(<MemoryProposalCard {...baseProps} />)

    await user.click(screen.getByRole('button', { name: 'No' }))

    expect(await screen.findByText('Not saved.')).toBeInTheDocument()
    expect(posts).toHaveLength(0)
  })
})
