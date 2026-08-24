/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const isOwner = { value: false }

vi.mock('@/lib/auth/session', () => ({
  getGridSession: vi.fn().mockResolvedValue({ userId: 'user_1', organizationId: 'org_1' }),
}))

vi.mock('@/lib/authz/platform', () => {
  // Defined inside the factory: vi.mock is hoisted above module-level classes.
  class PlatformAccessDeniedError extends Error {
    readonly status = 403
  }
  return {
    PlatformAccessDeniedError,
    requirePlatformOwner: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) {
        throw new PlatformAccessDeniedError()
      }
    }),
  }
})

const catalog = {
  cards: [
    {
      type: 'requirement_checklist',
      model: 'RequirementChecklistCard',
      summary: 'Several pass/fail criteria for one question.',
      emittedBy: 'agent',
      interaction: 'presentational',
      fields: [
        { name: 'title', type: 'string', required: true, description: '', constraints: ['non-empty'] },
        { name: 'items', type: '[ChecklistItem]', required: true, description: '', constraints: [] },
      ],
      example: null,
    },
  ],
  buildingBlocks: {
    ChecklistItem: [
      { name: 'label', type: 'string', required: true, description: '', constraints: [] },
    ],
  },
  cardCount: 1,
  featureRequest: {
    repository: 'https://github.com/GRID-check/grid-oib-agent',
    url: 'https://github.com/GRID-check/grid-oib-agent/issues/new?template=02-enhancement.yml&title=%5BFeature%5D%3A+',
    label: 'Missing a card, or a value on one? Open a feature request.',
  },
}

vi.mock('@/lib/platform/card-catalog', () => ({
  getCardCatalog: vi.fn().mockImplementation(async () => catalog),
}))

import { GET } from './route'
import { getCardCatalog } from '@/lib/platform/card-catalog'

const request = (): Request => new Request('http://localhost/api/platform/cards')

describe('GET /api/platform/cards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner.value = false
  })

  it('rejects non-owners with 403', async () => {
    expect((await GET(request())).status).toBe(403)
    expect(getCardCatalog).not.toHaveBeenCalled()
  })

  it('serves the catalog to the platform owner', async () => {
    isOwner.value = true
    const res = await GET(request())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cardCount).toBe(1)
    expect(body.cards[0].type).toBe('requirement_checklist')
    // The shape a field names travels with the catalog, so a reader can see
    // what a `[ChecklistItem]` actually contains.
    expect(body.buildingBlocks.ChecklistItem[0].name).toBe('label')
  })

  it('hands the reader somewhere to ask for what is missing', async () => {
    isOwner.value = true
    const body = await (await GET(request())).json()
    expect(body.featureRequest.url).toContain('github.com/GRID-check/grid-oib-agent/issues/new')
    expect(body.featureRequest.label).toBeTruthy()
  })

  it('relays a backend outage as 502 rather than an empty catalog', async () => {
    isOwner.value = true
    const { UpstreamError } = await import('@/lib/api/errors')
    vi.mocked(getCardCatalog).mockRejectedValueOnce(new UpstreamError('Card catalog backend unreachable'))
    const res = await GET(request())
    // An empty list would read as "Grid has no cards", which is the one answer
    // this endpoint must never give.
    expect(res.status).toBe(502)
  })
})
