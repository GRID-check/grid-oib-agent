/**
 * @vitest-environment node
 */
/**
 * The by-name resolve's two routes, driven THROUGH the typed client
 * (ADR-0055), so the client and the handlers cannot disagree about a path, a
 * verb or a field.
 *
 * The resolve exists because citation chips and surfaced-document cards looked
 * their document up in the listing's first page, and a document older than the
 * newest 500 resolved to nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('@/lib/documents/service', () => ({ resolveProjectDocumentsByName: vi.fn() }))
vi.mock('@/lib/documents/lifecycle', () => ({
  summarizeDocumentVersions: vi.fn().mockResolvedValue(new Map([['doc_1', { versionCount: 2, state: 'published' }]])),
}))
vi.mock('@/lib/archiv/service', () => ({ resolveArchivDocumentsByName: vi.fn() }))

import { ForbiddenError } from '@/lib/api/errors'
import { resolveProjectDocumentsByName, type ListedDocument } from '@/lib/documents/service'
import { resolveArchivDocumentsByName } from '@/lib/archiv/service'
import {
  ARCHIV_BY_NAME_PATH,
  PROJECT_BY_NAME_PATH,
  ByNameResolveError,
  createDocumentByNameClient,
} from '@/lib/documents/by-name-client'
import { FILENAME_LOOKUP_MAX_NAMES } from '@/lib/documents/filename-lookup'
import { POST as resolveProject } from './route'
import { POST as resolveArchiv } from '../../archiv/documents/by-name/route'

const handlers: Record<string, (request: Request) => Promise<Response>> = {
  [PROJECT_BY_NAME_PATH]: (request) => resolveProject(request, { params: Promise.resolve({}) }),
  [ARCHIV_BY_NAME_PATH]: (request) => resolveArchiv(request, { params: Promise.resolve({}) }),
}

const requests: Array<{ path: string; names: string[] }> = []
const client = createDocumentByNameClient(async (path, init) => {
  const handler = handlers[path]
  if (!handler) throw new Error(`no route for ${path}`)
  requests.push({ path, names: (JSON.parse(String(init?.body)) as { names: string[] }).names })
  return handler(new Request(new URL(path, 'https://grid.test'), init))
})

const LISTED = {
  id: 'doc_1',
  filename: 'Bestand-1962.pdf',
  displayName: null,
  fileSize: 10,
  contentType: 'application/pdf',
  status: 'completed',
  authoredBy: 'user',
  publishedVersionId: null,
  lifecycle: 'active',
  collectionName: 'proj_c',
  folderId: null,
  originPath: null,
  contentHash: null,
  createdAt: new Date('2020-01-01T00:00:00Z'),
  updatedAt: new Date('2020-01-01T00:00:00Z'),
  errorMessage: null,
  assignees: [],
} as ListedDocument

beforeEach(() => {
  requests.length = 0
  vi.mocked(resolveProjectDocumentsByName).mockResolvedValue([LISTED])
  vi.mocked(resolveArchivDocumentsByName).mockResolvedValue([])
})

describe('POST /api/documents/by-name', () => {
  it('answers with the listing row of each named document', async () => {
    const [row] = await client.project('proj_1', ['bestand-1962.PDF'])

    expect(resolveProjectDocumentsByName).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      'proj_1',
      ['bestand-1962.PDF'],
    )
    // The listing's wire row: ISO timestamps and the version summary.
    expect(row).toMatchObject({
      id: 'doc_1',
      filename: 'Bestand-1962.pdf',
      createdAt: '2020-01-01T00:00:00.000Z',
      versionCount: 2,
    })
  })

  it('asks nothing for no names', async () => {
    expect(await client.project('proj_1', [])).toEqual([])
    expect(resolveProjectDocumentsByName).not.toHaveBeenCalled()
  })

  it('splits a long batch into requests the route accepts', async () => {
    const names = Array.from({ length: FILENAME_LOOKUP_MAX_NAMES + 1 }, (_, i) => `f${i}.pdf`)
    await client.project('proj_1', names)
    expect(requests.map((request) => request.names.length)).toEqual([FILENAME_LOOKUP_MAX_NAMES, 1])
  })

  it('refuses a request longer than the bound', async () => {
    const names = Array.from({ length: FILENAME_LOOKUP_MAX_NAMES + 1 }, (_, i) => `f${i}.pdf`)
    const response = await resolveProject(
      new Request(`https://grid.test${PROJECT_BY_NAME_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj_1', names }),
      }),
      { params: Promise.resolve({}) },
    )
    expect(response.status).toBe(400)
  })

  it('carries the service refusal through as the status', async () => {
    vi.mocked(resolveProjectDocumentsByName).mockRejectedValueOnce(new ForbiddenError('no'))
    await expect(client.project('proj_1', ['EG.pdf'])).rejects.toMatchObject({ status: 403 })
    await expect(client.project('proj_1', ['EG.pdf'])).resolves.toHaveLength(1)
  })

  it('reports a transport failure as status 0', async () => {
    const offline = createDocumentByNameClient(async () => {
      throw new TypeError('network')
    })
    await expect(offline.project('proj_1', ['EG.pdf'])).rejects.toEqual(new ByNameResolveError(0))
  })
})

describe('POST /api/archiv/documents/by-name', () => {
  it('answers the Archiv', async () => {
    vi.mocked(resolveArchivDocumentsByName).mockResolvedValueOnce([
      { ...LISTED, id: 'a1', versionCount: null } as never,
    ])
    expect((await client.archiv(['EG.pdf'])).map((row) => row.id)).toEqual(['a1'])
    expect(resolveArchivDocumentsByName).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      ['EG.pdf'],
    )
  })

  it('refuses a malformed body', async () => {
    const response = await resolveArchiv(
      new Request(`https://grid.test${ARCHIV_BY_NAME_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: [] }),
      }),
      { params: Promise.resolve({}) },
    )
    expect(response.status).toBe(400)
  })
})
