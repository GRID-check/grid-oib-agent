/**
 * The run picker lists what a run can read. It used to read the first page of
 * each listing, so a project's older documents were simply not offered.
 */

import { describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { useProjectInventory } from './use-project-inventory'

const row = (id: string, filename: string) => ({
  id,
  filename,
  fileSize: 10,
  contentType: 'application/pdf',
  status: 'completed',
  createdAt: '2026-01-01T00:00:00Z',
})

describe('useProjectInventory', () => {
  it('offers every page of the project listing and the Archiv', async () => {
    server.use(
      http.get('/api/documents', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'p2'
          ? HttpResponse.json({ documents: [row('p-old', 'Bestand.pdf')], nextCursor: null })
          : HttpResponse.json({ documents: [row('p-new', 'Statik.pdf')], nextCursor: 'p2' })
      ),
      http.get('/api/archiv/documents', () =>
        HttpResponse.json({ documents: [row('a1', 'Detail.pdf')], nextCursor: null })
      )
    )

    const { result } = renderHook(() => useProjectInventory('proj-1', true))

    await waitFor(() => expect(result.current.documents).not.toBeNull())
    expect(result.current.documents?.map((doc) => [doc.name, doc.shelf])).toEqual([
      ['Statik.pdf', 'project'],
      ['Bestand.pdf', 'project'],
      ['Detail.pdf', 'archiv'],
    ])
  })

  it('lists no Archiv rows when the Archiv is gated off', async () => {
    server.use(
      http.get('/api/documents', () => HttpResponse.json({ documents: [row('p1', 'Plan.pdf')] })),
      http.get('/api/archiv/documents', () => HttpResponse.json({}, { status: 403 }))
    )

    const { result } = renderHook(() => useProjectInventory('proj-1', true))

    await waitFor(() => expect(result.current.documents?.map((doc) => doc.name)).toEqual(['Plan.pdf']))
  })
})
