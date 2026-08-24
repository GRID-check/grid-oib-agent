/**
 * The memory_proposal card lets the user complete an org-scoped memory write the
 * agent's service token can't make. This test proves each action targets the
 * right authenticated route (org vs project), that the project action is hidden
 * without a project in scope, that "No" writes nothing, and that the answer is
 * recorded on the owning message so a reload cannot re-offer a write that
 * already happened (`/api/organization/memory` is not idempotent).
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CardInteractions } from '../card-decision'
import { MemoryProposalCard } from './MemoryProposalCard'

// Controllable projectId for the mocked chat store.
let mockProjectId: string | null = 'proj-1'
// Decisions already recorded on the message the card belongs to.
let mockCardInteractions: CardInteractions | undefined
const setCardDecision = vi.fn()

interface MockStoreState {
  projectId: string | null
  currentConversation: { id: string; messages: Array<{ id: string; cardInteractions?: CardInteractions }> } | null
  conversations: []
  setCardDecision: typeof setCardDecision
}

const mockStoreState = (): MockStoreState => ({
  projectId: mockProjectId,
  currentConversation: {
    id: 'conv-1',
    messages: [{ id: 'msg-1', cardInteractions: mockCardInteractions }],
  },
  conversations: [],
  setCardDecision,
})

vi.mock('@/features/chat/store', () => {
  const useChatStore = (selector: (s: MockStoreState) => unknown) => selector(mockStoreState())
  // `useCardDecision` re-reads the store imperatively after writing, to detect a
  // write that could not land.
  useChatStore.getState = () => mockStoreState()
  return { useChatStore }
})

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
  cardKey: 'memory_proposal-0',
}

/** The same card as it renders inside a real answer (decision persisted). */
const ownedProps = { ...baseProps, messageId: 'msg-1' }

describe('MemoryProposalCard', () => {
  beforeEach(() => {
    mockProjectId = 'proj-1'
    mockCardInteractions = undefined
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

  // ── Decision persistence ──────────────────────────────────────────────────
  // Regression: the outcome used to live in component-local state, so after a
  // reload the card re-mounted as pending with a live "Yes" that would write
  // the same memory row a second time.

  it('records the decision on the owning message after a successful org save', async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<MemoryProposalCard {...ownedProps} />)

    await user.click(screen.getByRole('button', { name: 'Yes, remember org-wide' }))

    await waitFor(() =>
      expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'memory_proposal-0', 'savedOrg')
    )
  })

  it('records the decision on the owning message after a project save', async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<MemoryProposalCard {...ownedProps} />)

    await user.click(screen.getByRole('button', { name: 'Save to just this project' }))

    await waitFor(() =>
      expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'memory_proposal-0', 'savedProject')
    )
  })

  it('records a dismissal on the owning message', async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<MemoryProposalCard {...ownedProps} />)

    await user.click(screen.getByRole('button', { name: 'No' }))

    expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'memory_proposal-0', 'dismissed')
  })

  it('does NOT write again when the message already records a save (post-reload)', () => {
    mockCardInteractions = {
      'memory_proposal-0': { decision: 'savedOrg', decidedAt: '2026-07-28T09:00:00.000Z' },
    }
    stubFetch()
    render(<MemoryProposalCard {...ownedProps} />)

    expect(screen.getByText(/Saved to organization memory/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Yes, remember org-wide' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save to just this project' })).not.toBeInTheDocument()
  })

  it('stays dismissed across a remount when the message records a dismissal', () => {
    mockCardInteractions = {
      'memory_proposal-0': { decision: 'dismissed', decidedAt: '2026-07-28T09:00:00.000Z' },
    }
    stubFetch()
    render(<MemoryProposalCard {...ownedProps} />)

    expect(screen.getByText('Not saved.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'No' })).not.toBeInTheDocument()
  })

  it('still settles when the store write cannot land (its session was deleted)', async () => {
    // `setCardDecision` no-ops for an unknown message. The POST has already
    // happened by then, so the card must not keep offering the button — but it
    // must also not fall back on a decision the store DID record (that copy can
    // later be dropped by reconcileCardInteractions, and reviving it here would
    // mark a replacement card as decided).
    stubFetch()
    const user = userEvent.setup()
    render(<MemoryProposalCard {...baseProps} messageId="gone" />)

    await user.click(screen.getByRole('button', { name: 'No' }))

    expect(await screen.findByText('Not saved.')).toBeInTheDocument()
  })

  it('ignores a decision recorded under a DIFFERENT card key', () => {
    mockCardInteractions = {
      'memory_proposal-1': { decision: 'savedOrg', decidedAt: '2026-07-28T09:00:00.000Z' },
    }
    stubFetch()
    render(<MemoryProposalCard {...ownedProps} />)

    expect(screen.getByRole('button', { name: 'Yes, remember org-wide' })).toBeInTheDocument()
  })
})
