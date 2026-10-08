/**
 * The documents a role can be bound to span every listing page. The plan that is
 * the Bebauungsplan is as often the oldest upload as not, so the first page alone
 * is not enough.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { __resetDocumentRolesStore, useDocumentRoles } from './use-document-roles'

afterEach(() => __resetDocumentRolesStore())

describe('useDocumentRoles', () => {
  it('offers every page of the project listing', async () => {
    server.use(
      http.get('/api/projects/:id/document-roles', () => HttpResponse.json({ roles: [] })),
      http.get('/api/documents', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'p2'
          ? HttpResponse.json({ documents: [{ id: 'd-old', filename: 'Bebauungsplan.pdf' }], nextCursor: null })
          : HttpResponse.json({ documents: [{ id: 'd-new', filename: 'Statik.pdf' }], nextCursor: 'p2' })
      )
    )

    const { result } = renderHook(() => useDocumentRoles('proj-1'))

    await waitFor(() => expect(result.current.bindings).toEqual([]))
    expect(result.current.documents.map((doc) => doc.id)).toEqual(['d-new', 'd-old'])
  })

  it('still settles with no documents when the listing fails', async () => {
    server.use(
      http.get('/api/projects/:id/document-roles', () => HttpResponse.json({ roles: [] })),
      http.get('/api/documents', () => HttpResponse.json({}, { status: 500 }))
    )

    const { result } = renderHook(() => useDocumentRoles('proj-1'))

    await waitFor(() => expect(result.current.bindings).toEqual([]))
    expect(result.current.documents).toEqual([])
  })
})
