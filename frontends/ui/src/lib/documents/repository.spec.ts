/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { getDb } from '@/lib/db'
import { documentIdsExisting, findDocumentInOrg } from './repository'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('findDocumentInOrg', () => {
  it('does not query postgres when the id is a filename (#572)', async () => {
    await expect(
      findDocumentInOrg('HdB-Hamm_Schnitt-1_Ansicht-Nord-West.jpg', 'org_01KWEZPQ1B54E0KN9K838PCS89'),
    ).resolves.toBeNull()
    expect(getDb).not.toHaveBeenCalled()
  })
})

describe('documentIdsExisting', () => {
  it('does not bind a filename into a uuid IN-list (#572)', async () => {
    await expect(documentIdsExisting(['HdB-Hamm_Schnitt-1_Ansicht-Nord-West.jpg'])).resolves.toEqual(new Set())
    expect(getDb).not.toHaveBeenCalled()
  })
})
