/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sever the workos-authkit import chain pulled in via backend-proxy.
vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))
vi.mock('@/lib/db/schema', () => ({
  documents: { collectionName: 'collection_name', filename: 'filename' },
}))

import { getDb } from '@/lib/db'
import { asDb } from '@/test-utils/db-fixtures'
import { reconcileOrphanedVectors } from './vector-reconcile'

const fetchMock = vi.fn()

/** Stub getDb so `db.select({...}).from(documents)` resolves to `rows`. */
function stubRows(rows: { collectionName: string; filename: string }[]) {
  vi.mocked(getDb).mockReturnValue(asDb({ select: () => ({ from: () => Promise.resolve(rows) }) }))
}

/** A backend list response (array of FileInfo-ish objects). */
function listResponse(names: string[]) {
  return { ok: true, json: () => Promise.resolve(names.map((file_name) => ({ file_name }))) }
}

function deleteResponse(totalDeleted: number) {
  return { ok: true, json: () => Promise.resolve({ total_deleted: totalDeleted }) }
}

describe('reconcileOrphanedVectors', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deletes a chunk whose document row is gone, keeps live ones', async () => {
    stubRows([{ collectionName: 'proj_a', filename: 'live.pdf' }])
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

  it('treats a live document stored under a percent-encoded name as live (regression)', async () => {
    // DB has the real, decoded name; the vector store holds the encoded form.
    stubRows([{ collectionName: 'proj_a', filename: 'Zürich Plan.pdf' }])
    fetchMock.mockResolvedValueOnce(listResponse(['Z%C3%BCrich%20Plan.pdf']))

    const result = await reconcileOrphanedVectors()

    expect(result.orphansFound).toBe(0)
    expect(result.orphansDeleted).toBe(0)
    // No DELETE was issued — only the one list call.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('deletes an orphan stored under an encoded name (the historical leak)', async () => {
    // The document is gone from the DB; its encoded chunks linger.
    stubRows([{ collectionName: 'proj_a', filename: 'other.pdf' }])
    fetchMock.mockResolvedValueOnce(listResponse(['other.pdf', 'Alte%20Datei.pdf']))
    fetchMock.mockResolvedValueOnce(deleteResponse(5))

    const result = await reconcileOrphanedVectors()

    expect(result.orphansFound).toBe(1)
    expect(result.orphansDeleted).toBe(5)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ file_ids: ['Alte%20Datei.pdf'] })
  })

  it('never scans a collection that has no document rows (e.g. the OIB corpus)', async () => {
    stubRows([{ collectionName: 'proj_a', filename: 'a.pdf' }])
    fetchMock.mockResolvedValueOnce(listResponse(['a.pdf']))

    const result = await reconcileOrphanedVectors()

    expect(result.collectionsScanned).toBe(1)
    // Only proj_a was listed; the unrelated oib_knowledge collection was never fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/collections/proj_a/documents')
  })

  it('records a per-collection failure and continues', async () => {
    stubRows([
      { collectionName: 'proj_a', filename: 'a.pdf' },
      { collectionName: 'proj_b', filename: 'b.pdf' },
    ])
    // proj_a list fails; proj_b succeeds cleanly.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    fetchMock.mockResolvedValueOnce(listResponse(['b.pdf']))

    const result = await reconcileOrphanedVectors()

    expect(result.collectionsScanned).toBe(2)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].collectionName).toBe('proj_a')
  })
})
