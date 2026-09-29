/**
 * @vitest-environment node
 */
/**
 * The name probe's two routes, driven THROUGH the typed client (ADR-0055), so
 * the client and the handlers cannot disagree about a path, a verb or a field.
 *
 * The probe exists because the upload planner compared dropped names against
 * the listing the browser had loaded — paged, filterable, archived rows left
 * out — while the server's upload versions a same-name document in every one
 * of those cases.
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
vi.mock('@/lib/documents/service', () => ({ probeProjectDocumentNames: vi.fn() }))
vi.mock('@/lib/archiv/service', () => ({ probeArchivDocumentNames: vi.fn() }))

import { ForbiddenError } from '@/lib/api/errors'
import { probeProjectDocumentNames } from '@/lib/documents/service'
import { probeArchivDocumentNames } from '@/lib/archiv/service'
import {
  ARCHIV_NAME_PROBE_PATH,
  PROJECT_NAME_PROBE_PATH,
  NameProbeError,
  createDocumentNameProbeClient,
} from '@/lib/documents/name-probe-client'
import { NAME_PROBE_MAX_NAMES, type DocumentNameMatch } from '@/lib/documents/name-probe-types'
import { POST as probeProject } from './route'
import { POST as probeArchiv } from '../../archiv/documents/name-matches/route'

const handlers: Record<string, (request: Request) => Promise<Response>> = {
  [PROJECT_NAME_PROBE_PATH]: (request) => probeProject(request, { params: Promise.resolve({}) }),
  [ARCHIV_NAME_PROBE_PATH]: (request) => probeArchiv(request, { params: Promise.resolve({}) }),
}

const client = createDocumentNameProbeClient(async (path, init) => {
  const handler = handlers[path]
  if (!handler) throw new Error(`no route for ${path}`)
  return handler(new Request(new URL(path, 'https://grid.test'), init))
})

const MATCH: DocumentNameMatch = {
  id: 'doc_1',
  filename: 'EG.pdf',
  displayName: null,
  fileSize: 10,
  contentHash: null,
  folderId: null,
  authoredBy: 'user',
  lifecycle: 'archived',
}

beforeEach(() => {
  vi.mocked(probeProjectDocumentNames).mockResolvedValue([MATCH])
  vi.mocked(probeArchivDocumentNames).mockResolvedValue([MATCH])
})

describe('POST /api/documents/name-matches', () => {
  it('answers the project shelf, archived rows included', async () => {
    expect(await client.project('proj_1', ['EG.pdf', 'OG.pdf'])).toEqual([MATCH])
    expect(probeProjectDocumentNames).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      'proj_1',
      ['EG.pdf', 'OG.pdf'],
    )
  })

  it('asks nothing for no names', async () => {
    expect(await client.project('proj_1', [])).toEqual([])
    expect(probeProjectDocumentNames).not.toHaveBeenCalled()
  })

  it('refuses a probe longer than a folder drop can be', async () => {
    const names = Array.from({ length: NAME_PROBE_MAX_NAMES + 1 }, (_, i) => `f${i}.pdf`)
    const response = await probeProject(
      new Request(`https://grid.test${PROJECT_NAME_PROBE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj_1', names }),
      }),
      { params: Promise.resolve({}) },
    )
    expect(response.status).toBe(400)
    expect(probeProjectDocumentNames).not.toHaveBeenCalled()
  })

  it('splits a pick past the cap into probes the route accepts, one match per document', async () => {
    // One POST with every name was a 400 past the cap, and nothing uploaded.
    const names = Array.from({ length: NAME_PROBE_MAX_NAMES + 5 }, (_, i) => `f${i}.pdf`)
    expect(await client.project('proj_1', names)).toEqual([MATCH])
    const batches = vi.mocked(probeProjectDocumentNames).mock.calls.map(([, , batch]) => batch.length)
    expect(batches).toEqual([NAME_PROBE_MAX_NAMES, 5])
  })

  it('carries the service refusal through as the status', async () => {
    vi.mocked(probeProjectDocumentNames).mockRejectedValueOnce(new ForbiddenError('no'))
    await expect(client.project('proj_1', ['EG.pdf'])).rejects.toBeInstanceOf(NameProbeError)
  })
})

describe('POST /api/archiv/documents/name-matches', () => {
  it('answers the Archiv', async () => {
    expect(await client.archiv(['EG.pdf'])).toEqual([MATCH])
    expect(probeArchivDocumentNames).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      ['EG.pdf'],
    )
  })

  it('refuses a malformed body', async () => {
    const response = await probeArchiv(
      new Request('https://grid.test/api/archiv/documents/name-matches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: [] }),
      }),
      { params: Promise.resolve({}) },
    )
    expect(response.status).toBe(400)
  })
})
