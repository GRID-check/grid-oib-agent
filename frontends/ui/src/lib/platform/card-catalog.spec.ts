/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sever the server-only import chain pulled in transitively.
vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

import { UpstreamError } from '@/lib/api/errors'
import { getCardCatalog } from './card-catalog'

const fetchMock = vi.fn()

const catalog = {
  cards: [
    {
      type: 'summary',
      model: 'SummaryCard',
      summary: 'A concise overview of the answer for the user.',
      emittedBy: 'agent',
      interaction: 'presentational',
      fields: [
        { name: 'title', type: 'string', required: true, description: 'Short title', constraints: ['non-empty'] },
      ],
      example: null,
    },
    {
      type: 'memory_proposal',
      model: 'MemoryProposalCard',
      summary: 'A proposal to save a finding to long-term memory.',
      emittedBy: 'system',
      interaction: 'interactive',
      fields: [],
      example: { type: 'memory_proposal' },
    },
  ],
  buildingBlocks: {
    NormReference: [
      { name: 'document', type: 'string', required: true, description: '', constraints: [] },
    ],
  },
  cardCount: 2,
  featureRequest: {
    repository: 'https://github.com/GRID-check/grid-oib-agent',
    url: 'https://github.com/GRID-check/grid-oib-agent/issues/new?template=02-enhancement.yml',
    label: 'Missing a card, or a value on one? Open a feature request.',
  },
}

describe('card catalog service', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the catalog from the backend', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 }))

    const result = await getCardCatalog()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend:8000/v1/platform/cards',
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(result.cardCount).toBe(2)
    expect(result.cards[1].emittedBy).toBe('system')
    expect(result.cards[1].interaction).toBe('interactive')
    expect(result.buildingBlocks.NormReference[0].name).toBe('document')
  })

  it('surfaces an unreachable backend as an upstream error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(getCardCatalog()).rejects.toBeInstanceOf(UpstreamError)
  })

  it('surfaces a non-OK response as an upstream error', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(getCardCatalog()).rejects.toBeInstanceOf(UpstreamError)
  })

  it('rejects a catalog whose shape it cannot describe', async () => {
    // A backend older than this BFF: half a catalog reads as "Grid has no such
    // card", which is the wrong thing to send someone to the tracker with.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ cards: [{ type: 'summary' }] }), { status: 200 }),
    )
    await expect(getCardCatalog()).rejects.toBeInstanceOf(UpstreamError)
  })

  it('rejects a malformed body', async () => {
    fetchMock.mockResolvedValue(new Response('{oops', { status: 200 }))
    await expect(getCardCatalog()).rejects.toBeInstanceOf(UpstreamError)
  })
})
