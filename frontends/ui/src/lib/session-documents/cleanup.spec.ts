/**
 * @vitest-environment node
 */
/**
 * Erasing a chat's private attachments — and, more to the point, what happens
 * when that erasure FAILS.
 *
 * The document row is the only handle that names a session document's external
 * state: its object in SeaweedFS and its chunks in the retrieval collection.
 * Nothing else lists them, no ledger entry survives without the row, and the
 * key is presignable by anyone who learns it. So the invariant these tests pin
 * is one sentence: **the row outlives every failure to erase what it names.**
 *
 * Both halves used to break it. `deleteDocumentObjects` swallowed every S3
 * error, and `purgeCollectionChunks` treated any answer at all — a 500, a 404
 * naming the wrong collection — as a completed purge. The loop then deleted the
 * rows regardless, which is how a transient blip became private data nobody can
 * ever remove.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'

vi.mock('server-only', () => ({}))

const send = vi.fn()
vi.mock('@/lib/s3', async () => {
  const actual = await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3')
  return {
    ...actual,
    s3Client: { send: (...args: unknown[]) => send(...args) },
  }
})

vi.mock('@/lib/storage/bucket', () => ({
  resolveDocumentBucket: (bucket: string | null) => bucket ?? 'grid-documents',
}))

vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))

const deleteBimDerivedObjects = vi.fn()
vi.mock('@/lib/bim/service', () => ({
  deleteBimDerivedObjects: (...args: unknown[]) => deleteBimDerivedObjects(...args),
}))

const listSessionDocumentsForCleanup = vi.fn()
const deleteSessionDocumentsByIds = vi.fn()
vi.mock('./repository', () => ({
  listSessionDocumentsForCleanup: (...args: unknown[]) => listSessionDocumentsForCleanup(...args),
  deleteSessionDocumentsByIds: (...args: unknown[]) => deleteSessionDocumentsByIds(...args),
  SESSION_DOCUMENT_LIST_LIMIT: 100,
}))

import type { Document } from '@/lib/db/schema'
import { deleteDocumentObjects } from '@/lib/documents/object-cleanup'
import { purgeCollectionChunks, purgeSessionDocuments } from './cleanup'
import { collectionFileRef } from '@/lib/documents/collection-file-ref'

const CONVERSATION_ID = 's_11111111-2222-3333-4444-555555555555'
const ORG_ID = 'org_1'

function sessionDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: 'doc-1',
    organizationId: ORG_ID,
    conversationId: CONVERSATION_ID,
    scope: 'session',
    // A real session row carries this — every `documents` row does, since 0063.
    // Omitting it made the fixture a shape the application cannot produce, and
    // `collectionFileRef` (correctly) refuses such a row, which is what turned
    // the omission into a failing test rather than a silent one.
    authoredBy: 'user',
    filename: 'brandschutz.pdf',
    collectionName: CONVERSATION_ID,
    storageKey: `org/${ORG_ID}/session/${CONVERSATION_ID}/doc/doc-1/brandschutz.pdf`,
    storageBucket: 'grid-org-org1-abc',
    ...overrides,
  } as unknown as Document
}

/** A fetch stand-in: `ok` is what the code must now read, and used not to. */
function stubFetch(response: { ok: boolean; status?: number } | Error): void {
  vi.stubGlobal(
    'fetch',
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue({ ok: response.ok, status: response.status ?? (response.ok ? 200 : 500) }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  send.mockResolvedValue({})
  deleteBimDerivedObjects.mockResolvedValue(undefined)
  deleteSessionDocumentsByIds.mockResolvedValue(undefined)
  stubFetch({ ok: true })
})

describe('deleteDocumentObjects', () => {
  it('reports success once the object, its thumbnail and its BIM derivatives are gone', async () => {
    const result = await deleteDocumentObjects(sessionDoc())

    expect(result).toEqual({ ok: true })
    const keys = send.mock.calls.map((call) => (call[0] as DeleteObjectCommand).input.Key)
    expect(keys).toEqual([
      `org/${ORG_ID}/session/${CONVERSATION_ID}/doc/doc-1/brandschutz.pdf`,
      `org/${ORG_ID}/session/${CONVERSATION_ID}/doc/doc-1/_thumb.jpg`,
    ])
    expect(deleteBimDerivedObjects).toHaveBeenCalled()
  })

  it('reports FAILURE when SeaweedFS refuses the delete', async () => {
    send.mockRejectedValueOnce(new Error('connection reset'))

    const result = await deleteDocumentObjects(sessionDoc())

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('connection reset')
  })

  // The thumbnail is rendered FROM the private file and the `_bim/` derivatives
  // are the parsed building. Leaving either behind is a disclosure, not a
  // cosmetic remainder, so neither may be swallowed the way both used to be.
  it('reports FAILURE when the thumbnail cannot be removed', async () => {
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('thumb 503'))

    const result = await deleteDocumentObjects(sessionDoc())

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('thumb 503')
  })

  it('reports FAILURE when the BIM derivatives cannot be swept', async () => {
    deleteBimDerivedObjects.mockRejectedValue(new Error('list timed out'))

    const result = await deleteDocumentObjects(sessionDoc())

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('list timed out')
  })

  // Idempotency is what lets a retry finish: it re-walks documents whose object
  // it already deleted, so "not there" has to be the outcome we wanted.
  it('treats an object that is already gone as success', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))

    await expect(deleteDocumentObjects(sessionDoc())).resolves.toEqual({ ok: true })
  })

  // `storage_key` is NOT NULL, so this is the legacy/hand-edited shape rather
  // than one the upload path can produce — and a row naming no object has
  // nothing to erase, which is success.
  it('is a no-op success for a row that names no object', async () => {
    await expect(deleteDocumentObjects(sessionDoc({ storageKey: '' }))).resolves.toEqual({ ok: true })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('purgeCollectionChunks', () => {
  // Built through the constructor, like production: a bare filename is no
  // longer callable, which is the point of the signature.
  const ref = (filename: string) => {
    const value = collectionFileRef({ collectionName: CONVERSATION_ID, filename, authoredBy: 'user' })
    if (!value) throw new Error('fixture is not a user-authored row')
    return value
  }

  it('succeeds on a 2xx', async () => {
    await expect(purgeCollectionChunks(CONVERSATION_ID, [ref('a.pdf')])).resolves.toEqual({ ok: true })
  })

  // The bug: `fetch` rejects only on a transport error, so a 500 resolved and
  // every caller read that as "the chunks are gone".
  it('reports FAILURE on a non-2xx answer', async () => {
    stubFetch({ ok: false, status: 500 })

    const result = await purgeCollectionChunks(CONVERSATION_ID, [ref('a.pdf')])

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('500')
  })

  it('reports FAILURE when the backend is unreachable', async () => {
    stubFetch(new Error('ECONNREFUSED'))

    await expect(purgeCollectionChunks(CONVERSATION_ID, [ref('a.pdf')])).resolves.toMatchObject({ ok: false })
  })

  it('refuses a row that owns no chunks, so the purge cannot address another document', () => {
    // The gate, at the one place a caller could still have passed a bare string.
    // A machine-authored row is never ingested, so purging by its filename would
    // delete the chunks of whatever human document shares that name — the leak
    // this signature exists to make unrepresentable.
    expect(
      collectionFileRef({ collectionName: CONVERSATION_ID, filename: 'a.pdf', authoredBy: 'agent' })
    ).toBeNull()
  })

  it('does not call the backend for an empty file list', async () => {
    const result = await purgeCollectionChunks(CONVERSATION_ID, [])
    expect(result).toEqual({ ok: true })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('purgeSessionDocuments', () => {
  it('erases chunks, objects and rows for a clean conversation', async () => {
    listSessionDocumentsForCleanup
      .mockResolvedValueOnce([sessionDoc(), sessionDoc({ id: 'doc-2', filename: 'plan.ifc' })])
      .mockResolvedValue([])

    const result = await purgeSessionDocuments(CONVERSATION_ID, ORG_ID)

    expect(result).toMatchObject({ ok: true, purged: 2, retained: 0 })
    expect(deleteSessionDocumentsByIds).toHaveBeenCalledWith(['doc-1', 'doc-2'], ORG_ID, CONVERSATION_ID)
  })

  /**
   * THE regression. With the old code this test fails on both assertions: the
   * S3 error was swallowed, the function returned void, and the row went with
   * the rest of the page — leaving a private PDF in the tenant's bucket that
   * nothing lists, nothing can delete, and that still counts against the
   * organization's quota.
   */
  it('never sends a machine-authored filename to the chunk purge', async () => {
    // The sweep batches filenames per collection, and the batch is where a
    // machine-authored row would have addressed a human document's chunks: the
    // backend deletes by `file_ids`, so one wrong name in the list deletes
    // somebody else's passages while their row keeps its „zitierbar" badge.
    listSessionDocumentsForCleanup.mockResolvedValue([
      sessionDoc(),
      sessionDoc({ id: 'doc-2', filename: 'brandschutz.pdf', authoredBy: 'agent' } as Partial<Document>),
    ])

    await purgeSessionDocuments(CONVERSATION_ID, ORG_ID)

    const purge = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    )
    expect(purge, 'the human row is still purged').toBeTruthy()
    expect(JSON.parse((purge?.[1] as RequestInit).body as string)).toEqual({
      file_ids: ['brandschutz.pdf'],
    })
  })

  it('KEEPS the row when SeaweedFS refuses the delete', async () => {
    listSessionDocumentsForCleanup.mockResolvedValue([sessionDoc()])
    send.mockRejectedValue(new Error('SeaweedFS 500'))

    const result = await purgeSessionDocuments(CONVERSATION_ID, ORG_ID)

    expect(result.ok).toBe(false)
    expect(result.retained).toBe(1)
    // Called with NO ids: an empty delete, not a delete of the failed row.
    expect(deleteSessionDocumentsByIds).toHaveBeenCalledWith([], ORG_ID, CONVERSATION_ID)
  })

  it('KEEPS the row when the chunk purge answers non-2xx', async () => {
    listSessionDocumentsForCleanup.mockResolvedValue([sessionDoc()])
    stubFetch({ ok: false, status: 502 })

    const result = await purgeSessionDocuments(CONVERSATION_ID, ORG_ID)

    expect(result.ok).toBe(false)
    expect(result.retained).toBe(1)
    expect(deleteSessionDocumentsByIds).toHaveBeenCalledWith([], ORG_ID, CONVERSATION_ID)
    // The object is still swept — that is progress the retry need not repeat,
    // and an object already gone is success for the retry too.
    expect(send).toHaveBeenCalled()
  })

  it('keeps only the failed row and erases the rest of the page', async () => {
    const good = sessionDoc({ id: 'doc-good', storageKey: 'org/x/session/c/doc/good/a.pdf' })
    const bad = sessionDoc({ id: 'doc-bad', storageKey: 'org/x/session/c/doc/bad/b.pdf' })
    listSessionDocumentsForCleanup.mockResolvedValue([good, bad])
    send.mockImplementation((command: DeleteObjectCommand) =>
      command.input.Key?.includes('/bad/') ? Promise.reject(new Error('boom')) : Promise.resolve({}),
    )

    const result = await purgeSessionDocuments(CONVERSATION_ID, ORG_ID)

    expect(result).toMatchObject({ ok: false, purged: 1, retained: 1 })
    expect(deleteSessionDocumentsByIds).toHaveBeenCalledWith(['doc-good'], ORG_ID, CONVERSATION_ID)
  })

  /**
   * Retained rows stay in the listing at the same position, so a loop that
   * re-read until the page came back empty would re-attempt the same page for
   * ever. The old shape could not have this failure because it always emptied
   * what it read; keeping rows is what introduces it.
   */
  it('terminates when every row on the page is retained', async () => {
    listSessionDocumentsForCleanup.mockResolvedValue([sessionDoc()])
    send.mockRejectedValue(new Error('still down'))

    await purgeSessionDocuments(CONVERSATION_ID, ORG_ID)

    expect(listSessionDocumentsForCleanup.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('does nothing for a conversation with no attachments', async () => {
    listSessionDocumentsForCleanup.mockResolvedValue([])

    await expect(purgeSessionDocuments(CONVERSATION_ID, ORG_ID)).resolves.toMatchObject({
      ok: true,
      purged: 0,
    })
    expect(deleteSessionDocumentsByIds).not.toHaveBeenCalled()
  })
})
