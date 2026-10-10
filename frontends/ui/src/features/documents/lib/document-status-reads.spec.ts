import { describe, expect, it, vi } from 'vitest'
import type { FileItem } from '../components/project-file-workspace'
import {
  mergeStatusReads,
  nextStatusBatch,
  readDocumentStatuses,
  trackedPatchFromStatus,
  type DocumentStatusRead,
} from './document-status-reads'

const row = (id: string, status: string): FileItem => ({
  id,
  filename: `${id}.pdf`,
  displayName: null,
  fileSize: 1,
  contentType: 'application/pdf',
  status,
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('readDocumentStatuses', () => {
  it('reads each id from its status route, keeping only what the body carried', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/documents/a/status') return json({ status: 'completed', summary: 'S', filename: 'a.pdf' })
      if (url === '/api/documents/b/status') return json({ error: 'gone' }, 404)
      return json({ error: 'boom' }, 500)
    }) as unknown as typeof fetch

    const reads = await readDocumentStatuses(['a', 'b', 'c', 'a'], { fetcher })

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(reads.get('a')).toEqual({ kind: 'row', fields: { status: 'completed', summary: 'S' } })
    expect(reads.get('b')).toEqual({ kind: 'gone' })
    // A failed read is no answer, and the next tick asks again.
    expect(reads.has('c')).toBe(false)
  })

  it('keeps at most `concurrency` requests in flight', async () => {
    let inFlight = 0
    let peak = 0
    const fetcher = vi.fn(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return json({ status: 'processing' })
    }) as unknown as typeof fetch

    await readDocumentStatuses(['1', '2', '3', '4', '5', '6', '7'], { fetcher, concurrency: 3 })

    expect(fetcher).toHaveBeenCalledTimes(7)
    expect(peak).toBe(3)
  })
})

describe('nextStatusBatch', () => {
  it('takes everything when it fits', () => {
    expect(nextStatusBatch(['a', 'b'], 5, 3)).toEqual({ batch: ['a', 'b'], next: 0 })
  })

  it('walks a long list round-robin so no row starves', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const first = nextStatusBatch(ids, 0, 2)
    const second = nextStatusBatch(ids, first.next, 2)
    const third = nextStatusBatch(ids, second.next, 2)
    expect([first.batch, second.batch, third.batch]).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'a'],
    ])
  })
})

describe('mergeStatusReads', () => {
  it('merges by id and drops a row the server no longer has', () => {
    const rows = [row('a', 'processing'), row('b', 'completed'), row('c', 'processing')]
    const reads = new Map<string, DocumentStatusRead>([
      ['a', { kind: 'row', fields: { status: 'completed', pageCount: 4 } }],
      ['c', { kind: 'gone' }],
    ])

    const merged = mergeStatusReads(rows, reads)

    expect(merged.map((r) => [r.id, r.status, r.pageCount])).toEqual([
      ['a', 'completed', 4],
      ['b', 'completed', null],
    ])
    // Untouched rows keep their identity, so nothing downstream re-renders for them.
    expect(merged[1]).toBe(rows[1])
  })

  it('returns the same array when nothing changed', () => {
    const rows = [row('a', 'processing')]
    const reads = new Map<string, DocumentStatusRead>([['a', { kind: 'row', fields: { status: 'processing' } }]])
    expect(mergeStatusReads(rows, reads)).toBe(rows)
  })
})

describe('trackedPatchFromStatus', () => {
  it('settles a terminal status and waits on the rest', () => {
    expect(trackedPatchFromStatus('completed')).toEqual({ status: 'success', progress: 100 })
    expect(trackedPatchFromStatus('failed', 'Kaputt')).toEqual({ status: 'failed', errorMessage: 'Kaputt' })
    expect(trackedPatchFromStatus('processing')).toBeNull()
    expect(trackedPatchFromStatus('something-new')).toBeNull()
  })
})
