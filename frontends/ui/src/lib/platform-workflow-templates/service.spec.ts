import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformWorkflowTemplate } from '@/lib/db/schema'
import type { PlatformTemplateContent } from './types'

const repo = vi.hoisted(() => ({
  insertPlatformTemplate: vi.fn(),
  listAllPlatformTemplates: vi.fn(),
  listPublishedPlatformTemplates: vi.fn(),
  getPlatformTemplateById: vi.fn(),
  updatePlatformTemplateRow: vi.fn(),
  deletePlatformTemplateRow: vi.fn(),
}))

vi.mock('./repository', () => repo)

import {
  createPlatformTemplate,
  listGalleryTemplates,
  listPlatformTemplates,
  updatePlatformTemplate,
} from './service'

const content: PlatformTemplateContent = {
  de: { name: 'DE', description: 'd', category: 'C', definition: { version: 1, blocks: { objective: 'o' } } },
  en: { name: 'EN', description: 'd', category: 'C', definition: { version: 1, blocks: { objective: 'o' } } },
}

const row = (overrides: Partial<PlatformWorkflowTemplate> = {}): PlatformWorkflowTemplate => ({
  id: 'tpl_1',
  provenance: 'law',
  dataSources: ['ris'],
  agentType: 'deep_researcher',
  scheduleCron: '0 6 * * 1',
  scheduleTimezone: 'Europe/Vienna',
  content,
  published: true,
  sortOrder: 0,
  createdBy: 'user_1',
  createdByEmail: 'owner@example.com',
  createdAt: new Date('2026-07-20T00:00:00Z'),
  updatedAt: new Date('2026-07-21T00:00:00Z'),
  ...overrides,
})

describe('platform workflow templates service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists every template as full DTOs (platform owner)', async () => {
    repo.listAllPlatformTemplates.mockResolvedValue([row()])
    const [dto] = await listPlatformTemplates()
    expect(dto.id).toBe('tpl_1')
    expect(dto.createdByEmail).toBe('owner@example.com')
    expect(dto.createdAt).toBe('2026-07-20T00:00:00.000Z')
  })

  it('maps gallery templates to the lean, PII-free projection', async () => {
    repo.listPublishedPlatformTemplates.mockResolvedValue([row()])
    const [dto] = await listGalleryTemplates()
    expect(dto).toEqual({
      id: 'tpl_1',
      provenance: 'law',
      dataSources: ['ris'],
      scheduleCron: '0 6 * * 1',
      scheduleTimezone: 'Europe/Vienna',
      content,
    })
    expect('createdByEmail' in dto).toBe(false)
    expect('published' in dto).toBe(false)
  })

  it('applies defaults on create (agent, unpublished, all-sources when null)', async () => {
    repo.insertPlatformTemplate.mockImplementation(async (values) => row({ ...values }))
    await createPlatformTemplate(
      { provenance: 'auto', dataSources: null, content },
      { userId: 'user_9', email: 'a@b.c' },
    )
    const values = repo.insertPlatformTemplate.mock.calls[0][0]
    expect(values.agentType).toBe('deep_researcher')
    expect(values.published).toBe(false)
    expect(values.dataSources).toBeNull()
    expect(values.createdBy).toBe('user_9')
  })

  it('PATCH writes only supplied fields; null clears data sources', async () => {
    repo.updatePlatformTemplateRow.mockImplementation(async (_id, patch) => row(patch))
    await updatePlatformTemplate('tpl_1', { dataSources: null, published: false })
    const patch = repo.updatePlatformTemplateRow.mock.calls[0][1]
    expect(patch.dataSources).toBeNull()
    expect(patch.published).toBe(false)
    expect('provenance' in patch).toBe(false)
    expect('content' in patch).toBe(false)
  })

  it('returns null when patching an unknown id', async () => {
    repo.updatePlatformTemplateRow.mockResolvedValue(null)
    expect(await updatePlatformTemplate('missing', { published: true })).toBeNull()
  })
})
