/**
 * @vitest-environment node
 */
/**
 * `GET /api/documents` — the two narrowings the listing takes, and the one that
 * WIDENS.
 *
 * `authoredBy` is validated against the column's own tuple so an unknown value
 * is a 400 rather than a silently empty list somebody reads as „Piloti hat
 * nichts geschrieben". `includeArchived` is the other direction, and it exists
 * because archiving used to change nothing a reader could see: the chunks were
 * purged, `documents.lifecycle` was written, and no listing read the column.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    email: 'a@b.test',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'admin',
    permissions: [],
    accessToken: '',
    name: null,
    featureFlags: null,
  }),
}))
vi.mock('@/lib/documents/service', () => ({ listDocuments: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/documents/lifecycle', () => ({
  summarizeDocumentVersions: vi.fn().mockResolvedValue(new Map()),
}))

import { listDocuments } from '@/lib/documents/service'
import { GET } from './route'

const call = (query: string) =>
  GET(new Request(`https://grid.test/api/documents${query}`), {
    params: Promise.resolve({}),
  })

describe('GET /api/documents', () => {
  it('lists the working set by default — archived documents have left it', async () => {
    await call('?projectId=proj_1')
    expect(vi.mocked(listDocuments).mock.calls.at(-1)?.[2]).toMatchObject({
      includeArchived: false,
    })
  })

  it('widens to the archived ones on ?includeArchived=true', async () => {
    await call('?projectId=proj_1&includeArchived=true')
    expect(vi.mocked(listDocuments).mock.calls.at(-1)?.[2]).toMatchObject({
      includeArchived: true,
    })
  })

  it('refuses a value the flag cannot hold, rather than reading it as false', async () => {
    // `'false'`, `'1'` and a typo would all silently mean „the working set" if
    // this were a truthiness check, and the reader would be told there are no
    // archived documents.
    const response = await call('?projectId=proj_1&includeArchived=yes')
    expect(response.status).toBe(400)
  })

  it('validates the author filter against the column’s own tuple', async () => {
    expect((await call('?projectId=proj_1&authoredBy=nobody')).status).toBe(400)
  })
})
