import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { ARCHIV_SEARCH_SCOPE, projectSearchScope } from '../lib/file-shelf'
import { useFileSearch } from './use-file-search'

describe('useFileSearch', () => {
  let requests: Array<{ path: string; body: unknown }>

  beforeEach(() => {
    requests = []
    const answer = async ({ request }: { request: Request }) => {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() })
      return HttpResponse.json({ hits: [] })
    }
    server.use(
      http.post('/api/documents/search', answer),
      http.post('/api/archiv/documents/search', answer)
    )
  })

  it('searches a project with its id in the body', async () => {
    const { result } = renderHook(() => useFileSearch(projectSearchScope('proj-1')))
    act(() => result.current.setQuery('Brandschutz'))
    act(() => result.current.run())

    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toEqual({ path: '/api/documents/search', body: { q: 'Brandschutz', projectId: 'proj-1' } })
  })

  it('searches the Archiv on its own route, shelf-wide', async () => {
    const { result } = renderHook(() => useFileSearch(ARCHIV_SEARCH_SCOPE))
    act(() => result.current.setQuery('Brandschutz'))
    act(() => result.current.run())

    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toEqual({ path: '/api/archiv/documents/search', body: { q: 'Brandschutz' } })
  })

  it('offers the substring filter alone without a scope', () => {
    const { result } = renderHook(() => useFileSearch())
    expect(result.current.canSearch).toBe(false)
    act(() => result.current.run())
    expect(requests).toEqual([])
  })

  it('drops semantic mode on any edit to the query', async () => {
    const { result } = renderHook(() => useFileSearch(ARCHIV_SEARCH_SCOPE))
    act(() => result.current.setQuery('a'))
    act(() => result.current.run())
    await waitFor(() => expect(result.current.semantic.active).toBe(true))
    act(() => result.current.setQuery('ab'))
    expect(result.current.semantic.active).toBe(false)
  })
})
