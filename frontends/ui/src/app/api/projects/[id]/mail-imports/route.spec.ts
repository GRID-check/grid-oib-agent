/**
 * @vitest-environment node
 */
/**
 * The import list's HTTP contract (ADR-0131 rule 3): `limit` and `cursor` reach
 * the service as the schema read them, and a cursor this list did not write, or
 * a page larger than the cap, is a 400 rather than a first page nobody asked for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'p@grid.test',
    role: 'member',
  }),
}))

vi.mock('@/lib/mail-import/service', () => ({
  listMailImports: vi.fn(),
  startMailImport: vi.fn(),
}))

import { encodeDocumentListCursor } from '@/lib/documents/list-cursor'
import { listMailImports } from '@/lib/mail-import/service'
import { MAIL_IMPORT_LIST_PAGE_MAX } from '@/lib/mail-import/types'
import { GET } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const CURSOR = encodeDocumentListCursor({ createdAt: '2026-10-08T10:00:00.000000', id: '22222222-2222-4222-8222-222222222222' })

const list = (query = '') =>
  GET(new NextRequest(`https://grid.test/api/projects/${PROJECT}/mail-imports${query}`), {
    params: Promise.resolve({ id: PROJECT }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listMailImports).mockResolvedValue({ imports: [], nextCursor: null, maxSizeBytes: 1, partSize: 1 })
})

describe('GET /api/projects/[id]/mail-imports', () => {
  it('answers a page as { imports, nextCursor, maxSizeBytes, partSize }', async () => {
    const response = await list()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ imports: [], nextCursor: null, maxSizeBytes: 1, partSize: 1 })
    expect(listMailImports).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org_1' }), PROJECT, {})
  })

  it('passes the page size and the cursor on', async () => {
    await list(`?limit=5&cursor=${CURSOR}`)
    expect(listMailImports).toHaveBeenCalledWith(expect.anything(), PROJECT, { limit: 5, cursor: CURSOR })
  })

  it('refuses a cursor it did not write, and a page over the cap', async () => {
    const forged = Buffer.from('{"t":"x","i":"y"}').toString('base64url')
    for (const query of ['?cursor=20', `?cursor=${forged}`, `?limit=${MAIL_IMPORT_LIST_PAGE_MAX + 1}`, '?limit=0']) {
      expect((await list(query)).status, query).toBe(400)
    }
    expect(listMailImports).not.toHaveBeenCalled()
  })
})
