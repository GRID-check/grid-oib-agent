/**
 * Regression test for the profile-patch consent vulnerability: the before/after
 * rows the user sees MUST be derived from the patch that will actually be
 * written plus the current profile — never from a model-authored preview. A
 * prompt-injected context could otherwise show a benign preview while the patch
 * writes a different fact under `user_confirmed` provenance.
 *
 * Also covers decision persistence: Accept/Reject is recorded on the owning
 * message, so a reload cannot re-offer an Accept that would apply the same
 * patch to the brief a second time.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectProfilePatchCard } from './ProjectProfilePatchCard'
import type { CardInteractions } from '../card-decision'
import type { ProjectProfile, ProjectProfilePatchOperation } from '@/lib/project-profile/types'

// Decisions already recorded on the message the card belongs to.
let mockCardInteractions: CardInteractions | undefined
const setCardDecision = vi.fn()

interface MockStoreState {
  currentConversation: { id: string; messages: Array<{ id: string; cardInteractions?: CardInteractions }> } | null
  conversations: []
  setCardDecision: typeof setCardDecision
}

const mockStoreState = (): MockStoreState => ({
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

// The stored profile deliberately holds a value that CONFLICTS with anything a
// model-supplied preview might have claimed, so we can prove the "Before" column
// reflects the real profile and the "After" column reflects the real patch.
const storedProfile: ProjectProfile = {
  facts: {
    waermeversorgung: {
      value: 'gas',
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  },
  goals: {},
  unknowns: [],
  assumptions: {},
}

// What the patch will actually write — differs from the stored value.
const patch: ProjectProfilePatchOperation[] = [
  { op: 'add', path: '/facts/waermeversorgung', value: 'waermepumpe' },
]

interface StubbedFetch {
  fetch: ReturnType<typeof vi.fn>
  posts: Array<{ url: string; body: unknown }>
}

function stubFetch(postStatus = 200): StubbedFetch {
  const posts: Array<{ url: string; body: unknown }> = []
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
      return Promise.resolve({
        ok: postStatus < 400,
        status: postStatus,
        json: async () => (postStatus < 400 ? {} : { error: 'Conflict' }),
      })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ profile: storedProfile, profileVersion: 1 }),
    })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, posts }
}

/** The card as rendered inside a real answer, minus title/rationale. */
const cardProps = {
  title: 'Update brief',
  rationale: 'Learned the class.',
  patch,
  projectId: 'proj-1',
  cardKey: 'project_profile_patch-0',
}

/** …owned by a message, so its decision is persisted. */
const ownedProps = { ...cardProps, messageId: 'msg-1' }

describe('ProjectProfilePatchCard', () => {
  beforeEach(() => {
    mockCardInteractions = undefined
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('derives the rows from the patch and the fetched profile, not a model preview', async () => {
    stubFetch()
    render(
      <ProjectProfilePatchCard {...cardProps} />,
    )

    // The field label and the "after" value come straight from the patch.
    expect(await screen.findByText('Geplante Wärmeversorgung')).toBeInTheDocument()
    expect(screen.getByText('Wärmepumpe')).toBeInTheDocument()

    // Once the profile loads, the "Before" column shows the REAL stored value.
    expect(await screen.findByText('Gas (nur Bestand)')).toBeInTheDocument()
  })

  it('POSTs exactly { patch } on accept and shows the accepted state', async () => {
    const { posts } = stubFetch()
    const user = userEvent.setup()
    render(
      <ProjectProfilePatchCard {...cardProps} />,
    )

    await user.click(screen.getByRole('button', { name: 'Accept' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe('/api/projects/proj-1/profile/patches')
    expect(posts[0].body).toEqual({ patch })
    expect(await screen.findByText('Project brief updated.')).toBeInTheDocument()
  })

  it('shows the rejected state without POSTing on reject', async () => {
    const { posts } = stubFetch()
    const user = userEvent.setup()
    render(
      <ProjectProfilePatchCard {...cardProps} />,
    )

    await user.click(screen.getByRole('button', { name: 'Reject' }))

    expect(await screen.findByText('Changes discarded.')).toBeInTheDocument()
    expect(posts).toHaveLength(0)
  })

  // ── Decision persistence ──────────────────────────────────────────────────
  // Regression: the outcome used to live in component-local state, so after a
  // reload the card re-mounted as pending with a live Accept that would apply
  // the same patch to the brief again.

  it('records the acceptance on the owning message once the patch is applied', async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<ProjectProfilePatchCard {...ownedProps} />)

    await user.click(screen.getByRole('button', { name: 'Accept' }))

    await waitFor(() =>
      expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'project_profile_patch-0', 'accepted')
    )
  })

  /**
   * The concurrent-accept case, which only exists once a thread is shared
   * (ADR-0032): two collaborators press Accept, `updateProjectProfileIfVersion`
   * compares `profileVersion`, and the loser gets a 409.
   *
   * Showing that as an error left the card PENDING with a live Accept — a button
   * whose work is already done, offering to apply the same patch again. Settling as
   * accepted is the truthful outcome: the brief does hold this change.
   */
  it('settles as accepted when a colleague applied the same patch first (409)', async () => {
    const { posts } = stubFetch(409)
    const user = userEvent.setup()
    render(<ProjectProfilePatchCard {...ownedProps} />)

    await user.click(screen.getByRole('button', { name: 'Accept' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(await screen.findByText('Project brief updated.')).toBeInTheDocument()
    // Recorded, so a reload does not re-offer the button either.
    expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'project_profile_patch-0', 'accepted')
  })

  it('still surfaces a genuine failure rather than claiming success', async () => {
    // Only 409 means "already done". A 500 is a failure the user has to see, and the
    // card must stay actionable.
    stubFetch(500)
    const user = userEvent.setup()
    render(<ProjectProfilePatchCard {...ownedProps} />)

    await user.click(screen.getByRole('button', { name: 'Accept' }))

    expect(await screen.findByRole('button', { name: 'Accept' })).toBeInTheDocument()
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('records a rejection on the owning message', async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<ProjectProfilePatchCard {...ownedProps} />)

    await user.click(screen.getByRole('button', { name: 'Reject' }))

    expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'project_profile_patch-0', 'rejected')
  })

  it('cannot re-apply a patch the message already records as accepted (post-reload)', () => {
    mockCardInteractions = {
      'project_profile_patch-0': { decision: 'accepted', decidedAt: '2026-07-28T09:00:00.000Z' },
    }
    stubFetch()
    render(<ProjectProfilePatchCard {...ownedProps} />)

    expect(screen.getByText('Project brief updated.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })

  it('stays rejected across a remount when the message records a rejection', () => {
    mockCardInteractions = {
      'project_profile_patch-0': { decision: 'rejected', decidedAt: '2026-07-28T09:00:00.000Z' },
    }
    stubFetch()
    render(<ProjectProfilePatchCard {...ownedProps} />)

    expect(screen.getByText('Changes discarded.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })
})
