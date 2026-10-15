/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sever the workos-authkit import chain pulled in via backend-proxy.
vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))
// The per-collection re-read is `where(eq(documents.collectionName, X))`: the stub reads X back.
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: (column: unknown, value: unknown) => ({ column, value }),
}))
vi.mock('@/lib/db/schema', () => ({
  documents: { collectionName: 'collection_name', filename: 'filename', authoredBy: 'authored_by' },
}))

// The third half has its own spec (`cross-project/project-facts-mirror.spec.ts`).
const syncAllProjectFacts = vi.fn()
vi.mock('@/lib/cross-project/project-facts-mirror', () => ({
  syncAllProjectFacts: (...args: unknown[]) => syncAllProjectFacts(...args),
}))

import { getDb } from '@/lib/db'
import { asDb } from '@/test-utils/db-fixtures'
import { DOCUMENT_FACTS_BATCH, PROJECT_FACTS_FAILURE_NAME, reconcileOrphanedVectors } from './vector-reconcile'

describe('reconcileOrphanedVectors: the project facts half', () => {
  const fetchFacts = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchFacts)
    vi.mocked(getDb).mockReturnValue(asDb({ select: () => ({ from: () => Promise.resolve([]) }) }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('copies every project’s facts onto its chunks, and reports what it did', async () => {
    syncAllProjectFacts.mockResolvedValueOnce({ projects: 3, failed: 1, unsupported: false })
    const result = await reconcileOrphanedVectors()
    expect(result.projectFacts).toEqual({ projects: 3, failed: 1, unsupported: false })
  })

  it('records its failure without undoing the halves before it', async () => {
    syncAllProjectFacts.mockRejectedValueOnce(new Error('db down'))
    const result = await reconcileOrphanedVectors()
    expect(result.projectFacts).toBeUndefined()
    expect(result.failures).toContainEqual({ collectionName: PROJECT_FACTS_FAILURE_NAME, error: 'project facts: db down' })
  })
})

const fetchMock = vi.fn()

type Row = { collectionName: string; filename: string; authoredBy: string }

/**
 * Stub getDb so `db.select({...}).from(documents)` (the snapshot of every
 * collection) resolves to `rows`, and `.where(collection = X)` (the second
 * look at one collection before its orphans are deleted) to `now`'s rows of X,
 * which default to the snapshot's.
 */
function stubRows(rows: Row[], now: Row[] = rows) {
  const from = () =>
    Object.assign(Promise.resolve(rows), {
      where: (condition: { value: string }) => Promise.resolve(now.filter((row) => row.collectionName === condition.value)),
    })
  vi.mocked(getDb).mockReturnValue(asDb({ select: () => ({ from }) }))
}

/** A backend list response (array of FileInfo-ish objects). */
function listResponse(names: string[]) {
  return { ok: true, json: () => Promise.resolve(names.map((file_name) => ({ file_name }))) }
}

function deleteResponse(totalDeleted: number) {
  return { ok: true, json: () => Promise.resolve({ total_deleted: totalDeleted }) }
}

/** The backend's answer to the summary half of the sweep. */
function summaryResponse(forgotten: { collection: string; file_name: string }[], failures: { collection: string; error: string }[] = []) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        status: 'ok',
        dry_run: false,
        orphans_found: forgotten.length,
        orphans_forgotten: forgotten.length,
        forgotten,
        failures,
      }),
  }
}

const DOCUMENT_FACTS_URL = 'http://backend:8000/v1/maintenance/refresh-document-facts'

/** The fetches of the chunk and summary halves: everything before the document facts half. */
function callsBeforeDocumentFacts() {
  return fetchMock.mock.calls.filter((call) => call[0] !== DOCUMENT_FACTS_URL)
}

/** The summary call is the last fetch before the document facts half; everything before it is chunk work. */
function summaryCall() {
  const calls = callsBeforeDocumentFacts()
  const call = calls[calls.length - 1]
  return { url: call[0] as string, init: call[1] as RequestInit }
}

describe('reconcileOrphanedVectors', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    // Every scripted response below is chunk work; the summary half runs last
    // and, unless a test scripts it, finds nothing to forget.
    fetchMock.mockImplementation(() => Promise.resolve(summaryResponse([])))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // A machine-authored row is never ingested, so it owns no chunks — but it
  // does keep its project alive. The two halves of that are tested separately
  // because getting either one wrong breaks the sweep in opposite directions.
  it('does not let a machine-authored row shield an orphan that shares its name', async () => {
    // The deleted Gutachten's chunks were missed; Piloti's report then landed
    // on the same filename. Without the authorship filter the sweep reads that
    // name as live and the deleted document keeps answering questions.
    stubRows([{ collectionName: 'proj_a', filename: 'sicherheitskonzept.pdf', authoredBy: 'agent' }])
    fetchMock.mockResolvedValueOnce(listResponse(['sicherheitskonzept.pdf']))
    fetchMock.mockResolvedValueOnce(deleteResponse(7))

    const result = await reconcileOrphanedVectors()

    expect(result.orphansFound).toBe(1)
    expect(result.orphansDeleted).toBe(7)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ file_ids: ['sicherheitskonzept.pdf'] })
  })

  it('still scans a collection whose only remaining rows are machine-authored', async () => {
    // Dropping the collection instead of the name would be the opposite bug:
    // a project whose uploads were all deleted would stop being swept, and the
    // orphans this module exists to recover would survive forever.
    stubRows([
      { collectionName: 'proj_a', filename: 'bericht-2026-08-20.pdf', authoredBy: 'agent' },
    ])
    fetchMock.mockResolvedValueOnce(listResponse(['geloescht.pdf']))
    fetchMock.mockResolvedValueOnce(deleteResponse(4))

    const result = await reconcileOrphanedVectors()

    expect(result.collectionsScanned).toBe(1)
    expect(result.orphansDeleted).toBe(4)
  })

  it('keeps a user row live even when a machine-authored row shares its name', async () => {
    // The collision must cost the agent row its shield, never the real
    // document its chunks.
    stubRows([
      { collectionName: 'proj_a', filename: 'plan.pdf', authoredBy: 'agent' },
      { collectionName: 'proj_a', filename: 'plan.pdf', authoredBy: 'user' },
    ])
    fetchMock.mockResolvedValueOnce(listResponse(['plan.pdf']))

    const result = await reconcileOrphanedVectors()

    expect(result.orphansFound).toBe(0)
    // One list call, then the summary half; no DELETE in between.
    expect(callsBeforeDocumentFacts()).toHaveLength(2)
  })

  it('shields only `user`, so an author value nobody has added yet owns no chunks', async () => {
    // An allow-list, not `!== 'agent'`. `document-authors.ts` anticipates a
    // later `system` or `import` and the column carries no CHECK, so a value
    // this code has not heard of is reachable — and a machine-authored row that
    // shields a filename disarms the sweep for whatever human document shares
    // it. There is deliberately no test for a row that OMITS the column: the
    // select always includes it and `stubRows` requires it, so that row is a
    // compile error rather than a branch that has to choose.
    stubRows([{ collectionName: 'proj_a', filename: 'import.pdf', authoredBy: 'import' }])
    fetchMock.mockResolvedValueOnce(listResponse(['import.pdf']))
    fetchMock.mockResolvedValueOnce(deleteResponse(2))

    const result = await reconcileOrphanedVectors()

    expect(result.orphansFound).toBe(1)
  })

  it('deletes a chunk whose document row is gone, keeps live ones', async () => {
    stubRows([{ collectionName: 'proj_a', filename: 'live.pdf', authoredBy: 'user' }])
    // Stored: one live + one orphan.
    fetchMock.mockResolvedValueOnce(listResponse(['live.pdf', 'ghost.pdf']))
    fetchMock.mockResolvedValueOnce(deleteResponse(3))

    const result = await reconcileOrphanedVectors()

    expect(result.collectionsScanned).toBe(1)
    expect(result.orphansFound).toBe(1)
    expect(result.orphansDeleted).toBe(3)
    expect(result.failures).toEqual([])
    // The DELETE targeted only the orphan, by its exact stored name.
    const deleteCall = fetchMock.mock.calls[1]
    expect(deleteCall[1].method).toBe('DELETE')
    expect(JSON.parse(deleteCall[1].body)).toEqual({ file_ids: ['ghost.pdf'] })
  })

  it('does not delete the chunks of a document filed after the snapshot was taken', async () => {
    // The live names are read once, before a sweep that may run for minutes. A
    // document uploaded in between has a row and chunks the snapshot never saw.
    const before = [{ collectionName: 'proj_a', filename: 'live.pdf', authoredBy: 'user' }]
    // Its row holds the decoded name; its chunks were stored under the encoded one.
    stubRows(before, [...before, { collectionName: 'proj_a', filename: 'Neu hochgeladen.pdf', authoredBy: 'user' }])
    fetchMock.mockResolvedValueOnce(listResponse(['live.pdf', 'Neu%20hochgeladen.pdf', 'ghost.pdf']))
    fetchMock.mockResolvedValueOnce(deleteResponse(2))

    const result = await reconcileOrphanedVectors()

    expect(result.orphansFound).toBe(1)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ file_ids: ['ghost.pdf'] })
  })

  it('deletes nothing in a collection whose every candidate turned out live on the second look', async () => {
    const before = [{ collectionName: 'proj_a', filename: 'live.pdf', authoredBy: 'user' }]
    stubRows(before, [...before, { collectionName: 'proj_a', filename: 'neu.pdf', authoredBy: 'user' }])
    fetchMock.mockResolvedValueOnce(listResponse(['live.pdf', 'neu.pdf']))

    const result = await reconcileOrphanedVectors()

    expect(result.orphansFound).toBe(0)
    expect(callsBeforeDocumentFacts().some((call) => call[1]?.method === 'DELETE')).toBe(false)
  })

  it('treats a live document stored under a percent-encoded name as live (regression)', async () => {
    // DB has the real, decoded name; the vector store holds the encoded form.
    stubRows([{ collectionName: 'proj_a', filename: 'Zürich Plan.pdf', authoredBy: 'user' }])
    fetchMock.mockResolvedValueOnce(listResponse(['Z%C3%BCrich%20Plan.pdf']))

    const result = await reconcileOrphanedVectors()

    expect(result.orphansFound).toBe(0)
    expect(result.orphansDeleted).toBe(0)
    // No DELETE was issued — the one list call, then the summary half.
    expect(callsBeforeDocumentFacts()).toHaveLength(2)
  })

  it('deletes an orphan stored under an encoded name (the historical leak)', async () => {
    // The document is gone from the DB; its encoded chunks linger.
    stubRows([{ collectionName: 'proj_a', filename: 'other.pdf', authoredBy: 'user' }])
    fetchMock.mockResolvedValueOnce(listResponse(['other.pdf', 'Alte%20Datei.pdf']))
    fetchMock.mockResolvedValueOnce(deleteResponse(5))

    const result = await reconcileOrphanedVectors()

    expect(result.orphansFound).toBe(1)
    expect(result.orphansDeleted).toBe(5)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ file_ids: ['Alte%20Datei.pdf'] })
  })

  it('never scans a collection that has no document rows (e.g. the OIB corpus)', async () => {
    stubRows([{ collectionName: 'proj_a', filename: 'a.pdf', authoredBy: 'user' }])
    fetchMock.mockResolvedValueOnce(listResponse(['a.pdf']))

    const result = await reconcileOrphanedVectors()

    expect(result.collectionsScanned).toBe(1)
    // Only proj_a was listed; the unrelated oib_knowledge collection was never
    // fetched, and the summary half was scoped to proj_a alone.
    expect(callsBeforeDocumentFacts()).toHaveLength(2)
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/collections/proj_a/documents')
    expect(JSON.parse(summaryCall().init.body as string)).toEqual({ collections: ['proj_a'], dry_run: false })
  })

  it('records a per-collection failure and continues', async () => {
    stubRows([
      { collectionName: 'proj_a', filename: 'a.pdf', authoredBy: 'user' },
      { collectionName: 'proj_b', filename: 'b.pdf', authoredBy: 'user' },
    ])
    // proj_a list fails; proj_b succeeds cleanly.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    fetchMock.mockResolvedValueOnce(listResponse(['b.pdf']))

    const result = await reconcileOrphanedVectors()

    expect(result.collectionsScanned).toBe(2)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].collectionName).toBe('proj_a')
  })

  // The second half of the run: summary rows whose chunks are gone. The backend
  // does the comparison; this tier only scopes it and records what came back.
  it('forgets chunk-less summaries in the collections it just walked, after the chunk pass', async () => {
    stubRows([{ collectionName: 'proj_a', filename: 'live.pdf', authoredBy: 'user' }])
    fetchMock.mockResolvedValueOnce(listResponse(['live.pdf', 'ghost.pdf']))
    fetchMock.mockResolvedValueOnce(deleteResponse(3))
    fetchMock.mockResolvedValueOnce(summaryResponse([{ collection: 'proj_a', file_name: 'alt.pdf' }]))

    const result = await reconcileOrphanedVectors()

    expect(result.orphansDeleted).toBe(3)
    expect(result.summariesForgotten).toBe(1)
    expect(result.failures).toEqual([])
    const { url, init } = summaryCall()
    expect(url).toBe('http://backend:8000/v1/maintenance/reconcile-summaries')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ collections: ['proj_a'], dry_run: false })
    // Third call: the chunk half (list, delete) ran first.
    expect(callsBeforeDocumentFacts()).toHaveLength(3)
  })

  it('sends the internal token the maintenance route is guarded by', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'real-secret')
    stubRows([{ collectionName: 'proj_a', filename: 'a.pdf', authoredBy: 'user' }])
    fetchMock.mockResolvedValueOnce(listResponse(['a.pdf']))

    await reconcileOrphanedVectors()

    const headers = summaryCall().init.headers as Record<string, string>
    expect(headers['x-grid-internal-token']).toBe('real-secret')
    vi.unstubAllEnvs()
  })

  it('records a per-collection summary failure under that collection, and keeps the chunk result', async () => {
    stubRows([
      { collectionName: 'proj_a', filename: 'a.pdf', authoredBy: 'user' },
      { collectionName: 'proj_b', filename: 'b.pdf', authoredBy: 'user' },
    ])
    fetchMock.mockResolvedValueOnce(listResponse(['a.pdf', 'ghost.pdf']))
    fetchMock.mockResolvedValueOnce(deleteResponse(2))
    fetchMock.mockResolvedValueOnce(listResponse(['b.pdf']))
    fetchMock.mockResolvedValueOnce(
      summaryResponse([{ collection: 'proj_a', file_name: 'x.pdf' }], [{ collection: 'proj_b', error: 'chroma timeout' }]),
    )

    const result = await reconcileOrphanedVectors()

    expect(result.orphansDeleted).toBe(2)
    expect(result.summariesForgotten).toBe(1)
    expect(result.failures).toEqual([{ collectionName: 'proj_b', error: 'summary reconcile: chroma timeout' }])
  })

  it('a refused summary sweep is one recorded failure, not a failed run', async () => {
    stubRows([{ collectionName: 'proj_a', filename: 'a.pdf', authoredBy: 'user' }])
    fetchMock.mockResolvedValueOnce(listResponse(['a.pdf', 'ghost.pdf']))
    fetchMock.mockResolvedValueOnce(deleteResponse(5))
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })

    const result = await reconcileOrphanedVectors()

    // The chunk half stands.
    expect(result.orphansDeleted).toBe(5)
    expect(result.summariesForgotten).toBe(0)
    expect(result.failures).toEqual([{ collectionName: '*', error: 'summary reconcile: reconcile-summaries returned 503' }])
  })

  it('does not call the backend for summaries when no collection is live', async () => {
    stubRows([])

    const result = await reconcileOrphanedVectors()

    expect(result.collectionsScanned).toBe(0)
    expect(result.summariesForgotten).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// The fourth half: a copy of a document's facts that failed after an edit
// (`writes.refresh_facts` never raises) left the old tags or superseded mark
// on its chunks, and the cross-project tag filters read them.
describe('reconcileOrphanedVectors: the document facts half', () => {
  const documentFactsCalls = () => fetchMock.mock.calls.filter((call) => call[0] === DOCUMENT_FACTS_URL)
  const refreshed = (collections: number, files: number, failures: { collection: string; error: string }[] = []) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ status: 'ok', collections_scanned: collections, files_refreshed: files, failures }),
  })
  const live = (count: number) =>
    Array.from({ length: count }, (_, n) => ({ collectionName: `proj_${n}`, filename: 'a.pdf', authoredBy: 'user' }))

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'real-secret')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('copies every live collection’s document facts again, in bounded batches, with the internal token', async () => {
    stubRows(live(DOCUMENT_FACTS_BATCH + 3))
    fetchMock.mockImplementation((url: string) => {
      if (url === DOCUMENT_FACTS_URL) return Promise.resolve(refreshed(0, 0))
      if (url.endsWith('/documents')) return Promise.resolve(listResponse(['a.pdf']))
      return Promise.resolve(summaryResponse([]))
    })

    await reconcileOrphanedVectors()

    const calls = documentFactsCalls()
    expect(calls.map((call) => JSON.parse(call[1].body).collections.length)).toEqual([DOCUMENT_FACTS_BATCH, 3])
    expect(calls.flatMap((call) => JSON.parse(call[1].body).collections)).toEqual(live(DOCUMENT_FACTS_BATCH + 3).map((row) => row.collectionName))
    expect(calls[0][1].headers['x-grid-internal-token']).toBe('real-secret')
    expect(calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('reports what it copied, and a collection the backend could not copy under its name', async () => {
    stubRows(live(2))
    fetchMock.mockImplementation((url: string) => {
      if (url === DOCUMENT_FACTS_URL) return Promise.resolve(refreshed(2, 7, [{ collection: 'proj_1', error: 'timed out' }]))
      if (url.endsWith('/documents')) return Promise.resolve(listResponse(['a.pdf']))
      return Promise.resolve(summaryResponse([]))
    })

    const result = await reconcileOrphanedVectors()

    expect(result.documentFacts).toEqual({ collections: 2, files: 7, unsupported: false })
    expect(result.failures).toEqual([{ collectionName: 'proj_1', error: 'document facts: timed out' }])
  })

  it('records a refused batch under each of its collections, runs the next, and stops on a deployment without Qdrant', async () => {
    stubRows(live(DOCUMENT_FACTS_BATCH + 1))
    const answers = [{ ok: false, status: 503 }, refreshed(1, 2)]
    fetchMock.mockImplementation((url: string) => {
      if (url === DOCUMENT_FACTS_URL) return Promise.resolve(answers.shift())
      if (url.endsWith('/documents')) return Promise.resolve(listResponse(['a.pdf']))
      return Promise.resolve(summaryResponse([]))
    })

    const result = await reconcileOrphanedVectors()

    expect(result.documentFacts).toEqual({ collections: 1, files: 2, unsupported: false })
    expect(result.failures).toHaveLength(DOCUMENT_FACTS_BATCH)
    expect(result.failures[0]).toEqual({ collectionName: 'proj_0', error: 'document facts: refresh-document-facts returned 503' })

    fetchMock.mockClear()
    fetchMock.mockImplementation((url: string) => {
      if (url === DOCUMENT_FACTS_URL) return Promise.resolve({ ok: false, status: 409 })
      if (url.endsWith('/documents')) return Promise.resolve(listResponse(['a.pdf']))
      return Promise.resolve(summaryResponse([]))
    })
    const without = await reconcileOrphanedVectors()
    expect(without.documentFacts).toEqual({ collections: 0, files: 0, unsupported: true })
    expect(without.failures).toEqual([])
    expect(documentFactsCalls()).toHaveLength(1)
  })
})
