/**
 * The by-name resolve behind citation chips and surfaced-document cards. A
 * name is asked of the server, never looked up in a listing page; the chips of
 * one render share one request; an answer is cached, a failure is not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetDocumentsByNameCache,
  resolveDocumentsByName,
  setDocumentsByNameFetch,
} from './documents-by-name'

type Row = { id: string; filename: string }

function server(options: { project?: Row[]; archiv?: Row[]; projectStatus?: number; archivStatus?: number }) {
  const calls: Array<{ path: string; body: { projectId?: string; names: string[] } }> = []
  const run = vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { projectId?: string; names: string[] }
    calls.push({ path, body })
    const archiv = path.startsWith('/api/archiv/')
    const status = (archiv ? options.archivStatus : options.projectStatus) ?? 200
    if (status !== 200) return new Response(null, { status })
    const wanted = new Set(body.names.map((name) => name.toLowerCase()))
    const rows = ((archiv ? options.archiv : options.project) ?? []).filter((row) =>
      wanted.has(row.filename.toLowerCase())
    )
    return Response.json({ documents: rows.map((row) => ({ ...row, createdAt: '2026-01-01T00:00:00Z' })) })
  })
  setDocumentsByNameFetch(run)
  return { calls, run }
}

beforeEach(() => resetDocumentsByNameCache())
afterEach(() => {
  resetDocumentsByNameCache()
  setDocumentsByNameFetch()
})

describe('resolveDocumentsByName', () => {
  it('answers each name with its rows per shelf, matched case-insensitively', async () => {
    server({ project: [{ id: 'p1', filename: 'Plan.pdf' }], archiv: [{ id: 'a1', filename: 'Detail.pdf' }] })

    const result = await resolveDocumentsByName('proj-1', ['PLAN.PDF', 'Detail.pdf', 'Fehlt.pdf'])

    expect(result.get('plan.pdf')).toMatchObject({ projekt: [{ id: 'p1' }], buero: [], error: false })
    expect(result.get('detail.pdf')).toMatchObject({ projekt: [], buero: [{ id: 'a1' }] })
    expect(result.get('fehlt.pdf')).toMatchObject({ projekt: [], buero: [], error: false })
  })

  it('sends the names asked in one task as one request per shelf', async () => {
    const { calls } = server({ project: [{ id: 'p1', filename: 'A.pdf' }, { id: 'p2', filename: 'B.pdf' }] })

    const [a, b] = await Promise.all([
      resolveDocumentsByName('proj-1', ['A.pdf']),
      resolveDocumentsByName('proj-1', ['B.pdf']),
    ])

    expect(a.get('a.pdf')?.projekt[0]?.id).toBe('p1')
    expect(b.get('b.pdf')?.projekt[0]?.id).toBe('p2')
    expect(calls.map((call) => call.path)).toEqual(['/api/documents/by-name', '/api/archiv/documents/by-name'])
    expect(calls[0].body).toEqual({ projectId: 'proj-1', names: ['A.pdf', 'B.pdf'] })
  })

  it('asks for a resolved name only once', async () => {
    const { run } = server({ project: [{ id: 'p1', filename: 'A.pdf' }] })

    await resolveDocumentsByName('proj-1', ['A.pdf'])
    await resolveDocumentsByName('proj-1', ['a.pdf'])

    expect(run).toHaveBeenCalledTimes(2) // project + Archiv, once
  })

  it('treats a gated Archiv as empty, not as a failure', async () => {
    server({ project: [{ id: 'p1', filename: 'A.pdf' }], archivStatus: 403 })

    const result = await resolveDocumentsByName('proj-1', ['A.pdf'])

    expect(result.get('a.pdf')).toMatchObject({ projekt: [{ id: 'p1' }], buero: [], error: false })
  })

  it('reports a genuine failure and does not cache it', async () => {
    const failing = server({ projectStatus: 500 })
    expect((await resolveDocumentsByName('proj-1', ['A.pdf'])).get('a.pdf')?.error).toBe(true)
    expect(failing.run).toHaveBeenCalled()

    server({ project: [{ id: 'p1', filename: 'A.pdf' }] })
    expect((await resolveDocumentsByName('proj-1', ['A.pdf'])).get('a.pdf')?.projekt[0]?.id).toBe('p1')
  })

  it('asks only the Archiv without a project', async () => {
    const { calls } = server({ archiv: [{ id: 'a1', filename: 'A.pdf' }] })

    const result = await resolveDocumentsByName(null, ['A.pdf'])

    expect(result.get('a.pdf')?.buero[0]?.id).toBe('a1')
    expect(calls.map((call) => call.path)).toEqual(['/api/archiv/documents/by-name'])
  })

  it('asks nothing for no names', async () => {
    const { run } = server({})
    expect((await resolveDocumentsByName('proj-1', ['', '  '])).size).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })
})
