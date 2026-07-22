/**
 * Regression test for the profile-patch consent vulnerability: the before/after
 * rows the user sees MUST be derived from the patch that will actually be
 * written plus the current profile — never from a model-authored preview. A
 * prompt-injected context could otherwise show a benign preview while the patch
 * writes a different fact under `user_confirmed` provenance.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectProfilePatchCard } from './ProjectProfilePatchCard'
import type { ProjectProfile, ProjectProfilePatchOperation } from '@/lib/project-profile/types'

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

function stubFetch(): StubbedFetch {
  const posts: Array<{ url: string; body: unknown }> = []
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
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

describe('ProjectProfilePatchCard', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('derives the rows from the patch and the fetched profile, not a model preview', async () => {
    stubFetch()
    render(
      <ProjectProfilePatchCard title="Update brief" rationale="Learned the class." patch={patch} projectId="proj-1" />,
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
      <ProjectProfilePatchCard title="Update brief" rationale="Learned the class." patch={patch} projectId="proj-1" />,
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
      <ProjectProfilePatchCard title="Update brief" rationale="Learned the class." patch={patch} projectId="proj-1" />,
    )

    await user.click(screen.getByRole('button', { name: 'Reject' }))

    expect(await screen.findByText('Changes discarded.')).toBeInTheDocument()
    expect(posts).toHaveLength(0)
  })
})
