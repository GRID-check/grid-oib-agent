/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { Document } from '@/lib/db/schema'
import type { FassungFacts } from './fassung'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend.test' }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('./fassung-facts', () => ({ loadFassungFacts: vi.fn() }))
vi.mock('@/lib/upload-screening/quarantine-reviewers', () => ({ shelfReaderFor: vi.fn() }))

import { recordAuditEvent } from '@/lib/audit/service'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { getAccessibleDocument } from './access'
import { loadFassungFacts } from './fassung-facts'
import { setFassungLink } from './fassung-service'

const session = { userId: 'user-1', organizationId: 'org-1', email: 'a@b.test' } as AuthorizedSession
const request = new Request('https://grid.test/api/documents/x/fassung', { method: 'PUT' })

const doc = (overrides: Partial<Document>): Document =>
  ({
    id: 'doc-b',
    filename: 'Grundriss_B.pdf',
    collectionName: 'proj_abc',
    scope: 'project',
    projectId: 'p1',
    folderId: null,
    lifecycle: 'active',
    authoredBy: 'user',
    publishedVersionId: null,
    status: 'completed',
    screeningOutcome: 'clean',
    contentHash: 'h',
    screenedHash: 'h',
    createdBy: 'user-1',
    ...overrides,
  }) as Document

const NEWER = doc({ id: 'doc-b', filename: 'Grundriss_B.pdf' })
const OLDER = doc({ id: 'doc-a', filename: 'Grundriss_A.pdf' })

const mockFetch = vi.fn()

function documentsById(...docs: Document[]) {
  vi.mocked(getAccessibleDocument).mockImplementation(async (_session, id) => {
    const found = docs.find((d) => d.id === id)
    if (!found) throw new NotFoundError()
    return found
  })
}

describe('setFassungLink', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ superseded_by: 'Grundriss_B.pdf' }), { status: 200 }))
    vi.mocked(getAccessibleDocument).mockReset()
    vi.mocked(loadFassungFacts).mockReset()
    vi.mocked(loadFassungFacts).mockResolvedValue(new Map())
    vi.mocked(shelfReaderFor).mockResolvedValue({ kind: 'member', userId: 'user-1' })
    vi.mocked(recordAuditEvent).mockClear()
    documentsById(NEWER, OLDER)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('links: asks for write access to both documents, tells the backend their file names, audits, and reads the facts back fresh', async () => {
    const newerFacts: FassungFacts = {
      supersededBy: null,
      supersedes: [{ id: 'doc-a', filename: 'Grundriss_A.pdf' }],
      suggestion: null,
      changeSummary: null,
    }
    const olderFacts: FassungFacts = {
      supersededBy: { id: 'doc-b', filename: 'Grundriss_B.pdf' },
      supersedes: [],
      suggestion: null,
      changeSummary: null,
    }
    vi.mocked(loadFassungFacts).mockResolvedValue(new Map([['doc-b', newerFacts], ['doc-a', olderFacts]]))

    const result = await setFassungLink(session, 'doc-b', 'doc-a', true, request)

    expect(getAccessibleDocument).toHaveBeenCalledWith(session, 'doc-b', 'write')
    expect(getAccessibleDocument).toHaveBeenCalledWith(session, 'doc-a', 'write')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://backend.test/v1/collections/proj_abc/fassung',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ newer: 'Grundriss_B.pdf', older: 'Grundriss_A.pdf', linked: true }),
      }),
    )
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'document.fassung_changed',
        targetType: 'document',
        targetId: 'doc-b',
        metadata: { olderDocumentId: 'doc-a', linked: true, collectionName: 'proj_abc' },
      }),
    )
    expect(loadFassungFacts).toHaveBeenCalledWith(session, [NEWER, OLDER], { kind: 'member', userId: 'user-1' }, { fresh: true })
    expect(result).toEqual({ id: 'doc-b', fassung: newerFacts, older: { id: 'doc-a', fassung: olderFacts } })
  })

  it('unlinks with linked: false', async () => {
    await setFassungLink(session, 'doc-b', 'doc-a', false, request)

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      newer: 'Grundriss_B.pdf',
      older: 'Grundriss_A.pdf',
      linked: false,
    })
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ linked: false }) }),
    )
  })

  it('answers null facts when the link left nothing to say', async () => {
    const result = await setFassungLink(session, 'doc-b', 'doc-a', false, request)

    expect(result).toEqual({ id: 'doc-b', fassung: null, older: { id: 'doc-a', fassung: null } })
  })

  it('lets the access check refuse: no write access is a 403 and nothing reaches the backend', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new ForbiddenError())

    await expect(setFassungLink(session, 'doc-b', 'doc-a', true, request)).rejects.toBeInstanceOf(ForbiddenError)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('refuses when write access to the OLDER document is missing', async () => {
    vi.mocked(getAccessibleDocument).mockImplementation(async (_s, id) => {
      if (id === 'doc-a') throw new ForbiddenError()
      return NEWER
    })

    await expect(setFassungLink(session, 'doc-b', 'doc-a', true, request)).rejects.toBeInstanceOf(ForbiddenError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('does not find a document the caller may not see', async () => {
    documentsById(NEWER)

    await expect(setFassungLink(session, 'doc-b', 'doc-a', true, request)).rejects.toBeInstanceOf(NotFoundError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects two documents of different collections', async () => {
    documentsById(NEWER, doc({ id: 'doc-a', filename: 'Grundriss_A.pdf', collectionName: 'proj_restricted' }))

    await expect(setFassungLink(session, 'doc-b', 'doc-a', true, request)).rejects.toMatchObject({
      status: 400,
      details: { reason: 'different_collection' },
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects a document linked to itself', async () => {
    await expect(setFassungLink(session, 'doc-b', 'doc-b', true, request)).rejects.toMatchObject({
      status: 400,
      details: { reason: 'same_document' },
    })
    expect(getAccessibleDocument).not.toHaveBeenCalled()
  })

  it('does not find a held document (ADR-0086), even one the caller may read as its reviewer', async () => {
    documentsById(NEWER, doc({ id: 'doc-a', filename: 'Grundriss_A.pdf', screeningOutcome: 'quarantined', status: 'quarantined' }))

    await expect(setFassungLink(session, 'doc-b', 'doc-a', true, request)).rejects.toBeInstanceOf(NotFoundError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects an archived document', async () => {
    documentsById(NEWER, doc({ id: 'doc-a', filename: 'Grundriss_A.pdf', lifecycle: 'archived' }))

    await expect(setFassungLink(session, 'doc-b', 'doc-a', true, request)).rejects.toMatchObject({
      status: 400,
      details: { reason: 'archived' },
    })
  })

  it('rejects a chat attachment', async () => {
    documentsById(doc({ id: 'doc-b', scope: 'session', projectId: null }), OLDER)

    await expect(setFassungLink(session, 'doc-b', 'doc-a', true, request)).rejects.toMatchObject({ status: 400 })
  })

  it('does not address a machine-authored row that owns nothing over there', async () => {
    documentsById(NEWER, doc({ id: 'doc-a', filename: 'bericht-2026-10-01.md', authoredBy: 'agent' }))

    await expect(setFassungLink(session, 'doc-b', 'doc-a', true, request)).rejects.toBeInstanceOf(NotFoundError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it.each([
    [404, 404],
    [400, 400],
    [409, 400],
    [500, 502],
  ])('maps a backend %i to %i and audits nothing', async (backend, mapped) => {
    mockFetch.mockResolvedValue(new Response('{}', { status: backend }))

    await expect(setFassungLink(session, 'doc-b', 'doc-a', true, request)).rejects.toMatchObject({ status: mapped })
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('maps an unreachable backend to 502', async () => {
    mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED'))

    await expect(setFassungLink(session, 'doc-b', 'doc-a', true, request)).rejects.toMatchObject({ status: 502 })
  })
})
