/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

// The tenant scopes are plain pass-throughs here: what this suite claims is
// about WHICH calls the service makes, and the scopes themselves are covered
// by `tenant-context.spec.ts` and the integration suites.
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => fn()),
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => unknown) => fn()),
}))

vi.mock('@/lib/knowledge/embeddings', () => ({
  embedNote: vi.fn(async () => ({ vector: [0.1, 0.2], fingerprint: 'test-embedder' })),
}))

vi.mock('@/lib/authz/resource-check', () => ({ checkResourcePermission: vi.fn(async () => true) }))
vi.mock('@/lib/authz/projects', () => ({ filterReadableProjects: vi.fn(async () => []) }))

vi.mock('@/lib/projects/memory-service', () => ({
  buildProjectMemoryDigest: vi.fn(async () => 'PROJECT_MEMORY v1\n- [decision] "Flachdach"'),
}))

vi.mock('./register-repository', () => ({
  loadRegisterSources: vi.fn(),
  upsertProjectRegisterRow: vi.fn(async () => undefined),
  markRegisterRowStale: vi.fn(async () => undefined),
  listRegisterWorkBatch: vi.fn(async () => []),
  listRegisterCandidates: vi.fn(async () => []),
}))

import { embedNote } from '@/lib/knowledge/embeddings'
import { checkResourcePermission } from '@/lib/authz/resource-check'
import { filterReadableProjects } from '@/lib/authz/projects'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  listRegisterCandidates,
  listRegisterWorkBatch,
  loadRegisterSources,
  markRegisterRowStale,
  upsertProjectRegisterRow,
  type RegisterCandidate,
} from './register-repository'
import {
  markProjectRegisterStale,
  rebuildProjectRegisterRow,
  recallSteckbriefe,
  reconcileProjectRegister,
} from './register-service'
import type { ProjectProfile } from '@/lib/project-profile/types'

const ORG = 'org_1'
const PROJECT = '11111111-1111-1111-1111-111111111111'

const sources = () => ({
  project: {
    id: PROJECT,
    name: 'Seestadt',
    profile: {
      facts: {
        projektphase: {
          value: 'entwurf',
          confidence: 'confirmed' as const,
          source: 'onboarding' as const,
          updatedAt: '',
        },
      },
      goals: {},
      unknowns: [],
      assumptions: {},
    } as ProjectProfile,
    profilePromptView: 'PROJECT_CONTEXT v1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  documents: [],
  documentCount: 0,
  lastActivityAt: new Date('2026-09-01T00:00:00.000Z'),
})

const candidate = (id: string, overrides: Partial<RegisterCandidate> = {}): RegisterCandidate => ({
  projectId: id,
  projectName: `Projekt ${id}`,
  steckbrief: `PROJECT_STECKBRIEF v1\nid=${id}`,
  status: null,
  bundesland: null,
  lastActivityAt: null,
  denseRank: 1,
  lexicalRank: 1,
  ...overrides,
})

const session = (): AuthorizedSession =>
  ({
    userId: 'user_1',
    organizationId: ORG,
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
    featureFlags: null,
    email: 'a@b.c',
    name: null,
    accessToken: 'tok',
  }) as AuthorizedSession

beforeEach(() => {
  vi.mocked(loadRegisterSources).mockResolvedValue(sources())
  vi.mocked(listRegisterWorkBatch).mockResolvedValue([])
  vi.mocked(listRegisterCandidates).mockResolvedValue([])
  vi.mocked(checkResourcePermission).mockResolvedValue(true)
  vi.mocked(embedNote).mockResolvedValue({ vector: [0.1, 0.2], fingerprint: 'test-embedder' })
})

afterEach(() => vi.clearAllMocks())

describe('rebuildProjectRegisterRow', () => {
  it('writes the Steckbrief with its embedding and clears nothing else', async () => {
    await expect(rebuildProjectRegisterRow(PROJECT, ORG)).resolves.toBe(true)
    expect(upsertProjectRegisterRow).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT,
        organizationId: ORG,
        projectName: 'Seestadt',
        status: 'entwurf',
        embedding: [0.1, 0.2],
        embeddingModel: 'test-embedder',
      })
    )
    const [values] = vi.mocked(upsertProjectRegisterRow).mock.calls[0]
    expect(values.steckbrief).toContain('PROJECT_STECKBRIEF v1')
    expect(values.steckbrief).toContain('PROJECT_MEMORY v1')
  })

  it('writes a Steckbrief with no vector when the embedder is unavailable', async () => {
    // Fail-open, the same contract memory rows have: a Steckbrief without a
    // vector is still found by the lexical channel; a missing one is not found
    // at all.
    vi.mocked(embedNote).mockResolvedValue(null)
    await expect(rebuildProjectRegisterRow(PROJECT, ORG)).resolves.toBe(true)
    expect(upsertProjectRegisterRow).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: null, embeddingModel: null })
    )
  })

  it('writes nothing for a project that is gone or another tenant’s', async () => {
    vi.mocked(loadRegisterSources).mockResolvedValue(null)
    await expect(rebuildProjectRegisterRow(PROJECT, ORG)).resolves.toBe(false)
    expect(upsertProjectRegisterRow).not.toHaveBeenCalled()
  })
})

describe('markProjectRegisterStale (the write-through every writer makes)', () => {
  it('stamps the row rather than rebuilding it', async () => {
    await markProjectRegisterStale(PROJECT, ORG)
    expect(markRegisterRowStale).toHaveBeenCalledWith(PROJECT, ORG)
    expect(upsertProjectRegisterRow).not.toHaveBeenCalled()
  })

  it('does nothing for an organization-scoped write, which names no project', async () => {
    await markProjectRegisterStale(null, ORG)
    expect(markRegisterRowStale).not.toHaveBeenCalled()
  })

  it('never throws — a register outage must not cost the caller its own write', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(markRegisterRowStale).mockRejectedValue(new Error('db down'))
    await expect(markProjectRegisterStale(PROJECT, ORG)).resolves.toBeUndefined()
  })
})

describe('reconcileProjectRegister', () => {
  it('is bounded: it never asks for more than one batch', async () => {
    await reconcileProjectRegister(500)
    expect(listRegisterWorkBatch).toHaveBeenCalledWith(50)
  })

  it('rebuilds every claimed row and reports the split', async () => {
    vi.mocked(listRegisterWorkBatch).mockResolvedValue([
      { projectId: 'p1', organizationId: 'org_a' },
      { projectId: 'p2', organizationId: 'org_b' },
    ])
    vi.mocked(loadRegisterSources)
      .mockResolvedValueOnce(sources())
      // p2 disappeared between the claim and the rebuild.
      .mockResolvedValueOnce(null)

    await expect(reconcileProjectRegister()).resolves.toEqual({
      claimed: 2,
      rebuilt: 1,
      skipped: 1,
    })
  })

  it('is idempotent: nothing stale claims nothing and writes nothing', async () => {
    await expect(reconcileProjectRegister()).resolves.toEqual({
      claimed: 0,
      rebuilt: 0,
      skipped: 0,
    })
    expect(upsertProjectRegisterRow).not.toHaveBeenCalled()
  })

  it('one project’s failure does not stop the batch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(listRegisterWorkBatch).mockResolvedValue([
      { projectId: 'p1', organizationId: 'org_a' },
      { projectId: 'p2', organizationId: 'org_b' },
    ])
    vi.mocked(loadRegisterSources)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(sources())

    await expect(reconcileProjectRegister()).resolves.toEqual({
      claimed: 2,
      rebuilt: 1,
      skipped: 1,
    })
  })
})

describe('recallSteckbriefe', () => {
  it('over-fetches, then filters, so a member with few projects still gets hits', async () => {
    // Forty candidates ranked, of which this member may read one — and it sits
    // below the limit. Filtering a limit-sized page would have returned none.
    const candidates = Array.from({ length: 40 }, (_, index) =>
      candidate(`p${index}`, { denseRank: index + 1, lexicalRank: null })
    )
    vi.mocked(listRegisterCandidates).mockResolvedValue(candidates)
    vi.mocked(checkResourcePermission).mockImplementation(
      async ({ resourceExternalId }) => resourceExternalId === 'p9'
    )

    const hits = await recallSteckbriefe(
      { organizationId: ORG, organizationMembershipId: 'om_1' },
      'Holzbau',
      5
    )

    expect(hits.map((hit) => hit.id)).toEqual(['p9'])
    // 5 × 3 candidates were asked for and checked; not forty, and not five.
    expect(listRegisterCandidates).toHaveBeenCalledWith(expect.objectContaining({ limit: 15 }))
    expect(vi.mocked(checkResourcePermission).mock.calls).toHaveLength(15)
  })

  it('never returns a project the caller may not read, at any ranking position', async () => {
    vi.mocked(listRegisterCandidates).mockResolvedValue([
      candidate('secret', { denseRank: 1, lexicalRank: 1 }),
      candidate('mine', { denseRank: 2, lexicalRank: 2 }),
    ])
    vi.mocked(checkResourcePermission).mockImplementation(
      async ({ resourceExternalId }) => resourceExternalId === 'mine'
    )

    const hits = await recallSteckbriefe(
      { organizationId: ORG, organizationMembershipId: 'om_1' },
      'Holzbau'
    )

    expect(hits.map((hit) => hit.id)).toEqual(['mine'])
  })

  it('returns nothing when the caller has no membership to check', async () => {
    vi.mocked(listRegisterCandidates).mockResolvedValue([candidate('p1')])
    await expect(
      recallSteckbriefe({ organizationId: ORG, organizationMembershipId: null }, 'Holzbau')
    ).resolves.toEqual([])
    expect(checkResourcePermission).not.toHaveBeenCalled()
  })

  it('asks the ONE readability function when it has a session', async () => {
    vi.mocked(listRegisterCandidates).mockResolvedValue([candidate('p1'), candidate('p2')])
    vi.mocked(filterReadableProjects).mockResolvedValue([{ id: 'p2' }])

    const hits = await recallSteckbriefe({ session: session() }, 'Holzbau')

    expect(filterReadableProjects).toHaveBeenCalledWith(expect.anything(), [
      { id: 'p1' },
      { id: 'p2' },
    ])
    expect(hits.map((hit) => hit.id)).toEqual(['p2'])
  })

  it('embeds the question on a ~1s budget and passes both channels down', async () => {
    vi.mocked(listRegisterCandidates).mockResolvedValue([candidate('p1')])
    await recallSteckbriefe({ organizationId: ORG, organizationMembershipId: 'om_1' }, 'Holzbau')
    expect(embedNote).toHaveBeenCalledWith('Holzbau', { timeoutMs: 1000 })
    expect(listRegisterCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Holzbau',
        embedding: { vector: [0.1, 0.2], fingerprint: 'test-embedder' },
      })
    )
  })

  it('asks for no ranking at all when there is no question', async () => {
    await recallSteckbriefe({ organizationId: ORG, organizationMembershipId: 'om_1' }, '   ')
    expect(embedNote).not.toHaveBeenCalled()
    expect(listRegisterCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ query: null, embedding: null })
    )
  })

  it('clamps the limit to the recall ceiling', async () => {
    await recallSteckbriefe({ organizationId: ORG, organizationMembershipId: 'om_1' }, 'x', 99)
    expect(listRegisterCandidates).toHaveBeenCalledWith(expect.objectContaining({ limit: 30 }))
  })

  it('ranks a two-channel hit above a one-channel hit', async () => {
    vi.mocked(listRegisterCandidates).mockResolvedValue([
      candidate('lexical-only', { denseRank: null, lexicalRank: 1 }),
      candidate('both', { denseRank: 2, lexicalRank: 2 }),
    ])
    const hits = await recallSteckbriefe(
      { organizationId: ORG, organizationMembershipId: 'om_1' },
      'Holzbau'
    )
    expect(hits.map((hit) => hit.id)).toEqual(['both', 'lexical-only'])
  })
})
