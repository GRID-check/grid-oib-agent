/**
 * A card highlight written as a FILTER, resolved against the whole model.
 *
 * This is the difference between a card that shows the answer and one that
 * shows a sample of it. An id list has to travel through the model's context
 * window, so "the 420 external walls in the Erdgeschoß" arrived as however
 * many the agent managed to transcribe — the viewer coloured those, the legend
 * said *Außenwände*, and nothing anywhere said the picture was a fraction.
 *
 * The filter is the same one `ifc_query` counted with, replayed by the browser
 * against the query endpoint, so the set is exact and costs the model nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { BIM_ELEMENTS_PAGE_LIMIT } from '@/lib/bim/types'
import { useBimHighlightGroups, type BimHighlightSpec } from './use-bim-model'

const MODEL_ID = 'model-1'

let fetchMock: ReturnType<typeof vi.fn>

/** The filter body of every element query the hook issued. */
function requestedFilters(): unknown[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).filter)
}

const rows = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, index) => ({
    globalId: `gid-${offset + index}`,
    expressId: offset + index,
    ifcType: 'IfcWall',
    name: null,
    storeyName: 'Erdgeschoss',
  }))

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useBimHighlightGroups', () => {
  it('resolves a filter into the ids it actually matches', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ elements: rows(3), total: 3 }) })
    const specs: BimHighlightSpec[] = [
      { match: { ifcTypes: ['IfcWall'], storeys: ['Erdgeschoss'] }, label: 'Außenwände', status: 'info' },
    ]

    const { result } = renderHook(() => useBimHighlightGroups(MODEL_ID, specs))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.data).toEqual([
      { globalIds: ['gid-0', 'gid-1', 'gid-2'], label: 'Außenwände', status: 'info' },
    ])
    // The filter goes to the endpoint verbatim — the property predicates the
    // browser could not evaluate itself are the whole reason this is a query.
    expect(requestedFilters()[0]).toEqual({ ifcTypes: ['IfcWall'], storeys: ['Erdgeschoss'] })
  })

  it('pages past the API cap, which is the case an id list could never reach', async () => {
    const PAGE = BIM_ELEMENTS_PAGE_LIMIT
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ elements: rows(PAGE), total: PAGE + 2 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ elements: rows(2, PAGE), total: PAGE + 2 }) })

    const specs: BimHighlightSpec[] = [{ match: { ifcTypes: ['IfcWall'] }, label: 'Wände', status: 'info' }]
    const { result } = renderHook(() => useBimHighlightGroups(MODEL_ID, specs))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.data?.[0].globalIds).toHaveLength(PAGE + 2)
  })

  it('costs nothing when every group already carries ids', async () => {
    const specs: BimHighlightSpec[] = [{ globalIds: ['gid-0'], label: 'T-14', status: 'fail' }]
    const { result } = renderHook(() => useBimHighlightGroups(MODEL_ID, specs))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.data).toEqual([{ globalIds: ['gid-0'], label: 'T-14', status: 'fail' }])
  })

  it('keeps a filter group that matched nothing, rather than dropping it', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ elements: [], total: 0 }) })
    const specs: BimHighlightSpec[] = [
      { match: { ifcTypes: ['IfcWall'] }, label: 'Ohne Feuerwiderstand', status: 'fail' },
    ]

    const { result } = renderHook(() => useBimHighlightGroups(MODEL_ID, specs))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // The legend still names it. "No wall fails this" and "this was never
    // checked" are different answers and must not look the same.
    expect(result.current.data).toEqual([{ globalIds: [], label: 'Ohne Feuerwiderstand', status: 'fail' }])
  })

  it('keeps a filter group that succeeded when another one fails', async () => {
    // Two FILTER groups, deliberately: an id-only group needs no request, so
    // pairing one with a failing filter cannot detect the bug this pins.
    // `Promise.all` rejects on the first failure, so one bad filter used to
    // discard the ids of every group that had already resolved — the opposite
    // of what the fallback promises.
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ elements: rows(2), total: 2 }) })
      .mockRejectedValueOnce(new Error('boom'))
    const specs: BimHighlightSpec[] = [
      { match: { ifcTypes: ['IfcWall'] }, label: 'Wände', status: 'info' },
      { match: { ifcTypes: ['IfcDoor'] }, label: 'Türen', status: 'fail' },
    ]

    const { result } = renderHook(() => useBimHighlightGroups(MODEL_ID, specs))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.data?.[0].globalIds).toEqual(['gid-0', 'gid-1'])
    // The one that failed falls back to nothing rather than taking the other
    // down with it, and the legend still names it.
    expect(result.current.data?.[1]).toEqual({ globalIds: [], label: 'Türen', status: 'fail' })
    expect(result.current.error).toBe('load-failed')
  })

  it('resolves one group at a time, so the page-walk cap is not multiplied', async () => {
    // `walkBimElements` caps itself at six pages in flight against a
    // ten-connection pool. Running groups in parallel multiplied that cap by
    // the group count — a five-group card issuing thirty concurrent queries.
    let inFlight = 0
    let peak = 0
    fetchMock.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return { ok: true, json: async () => ({ elements: rows(1), total: 1 }) }
    })
    const specs: BimHighlightSpec[] = Array.from({ length: 5 }, (_, index) => ({
      match: { ifcTypes: [`IfcType${index}`] },
      label: `group-${index}`,
      status: 'info' as const,
    }))

    const { result } = renderHook(() => useBimHighlightGroups(MODEL_ID, specs))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(peak).toBe(1)
  })

  it('does not re-query when an equal-but-new array arrives', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ elements: rows(1), total: 1 }) })
    const { result, rerender } = renderHook(
      ({ specs }: { specs: BimHighlightSpec[] }) => useBimHighlightGroups(MODEL_ID, specs),
      { initialProps: { specs: [{ match: { ifcTypes: ['IfcWall'] }, label: 'W', status: 'info' as const }] } }
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const before = fetchMock.mock.calls.length

    // A card payload is rebuilt on every render of the thread, so identity
    // changes constantly while the content does not.
    rerender({ specs: [{ match: { ifcTypes: ['IfcWall'] }, label: 'W', status: 'info' }] })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('asks nothing without a model', () => {
    const specs: BimHighlightSpec[] = [{ match: { ifcTypes: ['IfcWall'] }, label: 'W', status: 'info' }]
    renderHook(() => useBimHighlightGroups(null, specs))

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
