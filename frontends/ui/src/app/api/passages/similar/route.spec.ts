/**
 * @vitest-environment node
 *
 * `POST /api/passages/similar`, driven through its typed client (ADR-0055), so
 * the path, the verb, the body and the refusal the panel reads cannot drift
 * from the handler: what the client sends is what the route parses, and a held
 * source arrives in the browser as the reason the panel names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    organizationMembershipId: 'om-1',
    email: 'test@grid.com',
    role: 'member',
    permissions: [],
    featureFlags: null,
  }),
}))
vi.mock('@/lib/similar-passages/service', () => ({ findSimilarPassages: vi.fn() }))

import { BadRequestError } from '@/lib/api/errors'
import { fetchSimilarPassages, SIMILAR_PASSAGES_PATH, SimilarPassagesError } from '@/lib/similar-passages/client'
import { findSimilarPassages } from '@/lib/similar-passages/service'
import type { SimilarPassagesRequest, SimilarPassagesResponse } from '@/lib/similar-passages/types'
import { POST } from './route'

/** The client's fetch, answered by the real handler. */
const throughRoute: typeof fetch = async (input, init) => {
  expect(String(input)).toBe(SIMILAR_PASSAGES_PATH)
  const request = new NextRequest(`https://grid.test${String(input)}`, init as ConstructorParameters<typeof NextRequest>[1])
  return POST(request, { params: Promise.resolve({}) })
}

const REQUEST: SimilarPassagesRequest = {
  document: { kind: 'stored', documentId: 'doc-1' },
  passage: { text: 'Die Fluchttreppe wird als offene Außentreppe ausgeführt.', page: 4, cited: true },
  projectId: 'proj-1',
}

const RESPONSE: SimilarPassagesResponse = {
  groups: [
    {
      kind: 'project',
      project: { id: 'proj-2', name: 'Schule Baden', status: 'closed' },
      documents: [
        {
          documentId: 'doc-2',
          filename: 'Treppendetail.pdf',
          displayName: null,
          contentType: 'application/pdf',
          stand: { kind: 'index', text: 'Index C' },
          passages: [{ page: 3, snippet: 'Außentreppe aus Stahlbeton', score: 0.91 }],
        },
      ],
    },
  ],
  projectsSearched: 1,
  origin: 'point',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findSimilarPassages).mockResolvedValue(RESPONSE)
})

describe('POST /api/passages/similar through its client', () => {
  it('hands the service exactly what the client sent, and the client the answer', async () => {
    const answer = await fetchSimilarPassages(REQUEST, { fetcher: throughRoute })

    expect(answer).toEqual(RESPONSE)
    expect(findSimilarPassages).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), REQUEST)
  })

  it('refuses a passage too short to search, before the service runs', async () => {
    await expect(
      fetchSimilarPassages({ ...REQUEST, passage: { text: 'Stiege', cited: false } }, { fetcher: throughRoute })
    ).rejects.toMatchObject({ status: 400, reason: 'failed' })
    expect(findSimilarPassages).not.toHaveBeenCalled()
  })

  it('carries a held source to the browser as the reason the panel names', async () => {
    vi.mocked(findSimilarPassages).mockRejectedValue(new BadRequestError('held', { reason: 'held' }))

    const failure = await fetchSimilarPassages(REQUEST, { fetcher: throughRoute }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SimilarPassagesError)
    expect(failure).toMatchObject({ status: 400, reason: 'held' })
  })

  it('reads an answer that is not one as a failure, never as an empty list', async () => {
    const broken: typeof fetch = async () => new Response(JSON.stringify({ hits: [] }), { status: 200 })
    await expect(fetchSimilarPassages(REQUEST, { fetcher: broken })).rejects.toMatchObject({ reason: 'failed' })
  })
})
