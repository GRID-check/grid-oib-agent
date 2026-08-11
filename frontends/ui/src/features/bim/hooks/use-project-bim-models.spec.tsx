/**
 * One model list per project per moment, however many surfaces ask for it.
 *
 * The list stopped being one page's data. The chat welcome asks whether this
 * project has a readable model, the file preview asks which model belongs to
 * the document being previewed, its metadata rail asks what that model
 * contains, and every `ifc_viewer` card in a thread asks again. Each of those
 * mounts a separate hook, so opening a preview fired the identical request
 * three or four times within a tick — each spending a point of the `bim-query`
 * budget on rows the browser already had in flight.
 *
 * The collapse is in-flight only, deliberately: it can never show anyone a
 * stale model, so it needs no answer to "how old may this be".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useProjectBimModels } from './use-bim-model'

let fetchMock: ReturnType<typeof vi.fn>

/** Deferred so several hooks can mount while the first request is unresolved. */
function pending(): { resolve: () => void; promise: Promise<unknown> } {
  let release: () => void = () => {}
  const promise = new Promise<unknown>((done) => {
    release = () =>
      done({
        ok: true,
        json: async () => ({ models: [{ id: 'model-1', status: 'ready' }] }),
      })
  })
  return { resolve: release, promise }
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useProjectBimModels', () => {
  it('asks once when several surfaces ask at the same moment', async () => {
    const gate = pending()
    fetchMock.mockReturnValue(gate.promise)

    const first = renderHook(() => useProjectBimModels('proj-1'))
    const second = renderHook(() => useProjectBimModels('proj-1'))
    const third = renderHook(() => useProjectBimModels('proj-1'))

    expect(fetchMock).toHaveBeenCalledTimes(1)

    gate.resolve()
    // Every caller gets the answer, not just the one that happened to ask.
    for (const hook of [first, second, third]) {
      await waitFor(() => expect(hook.result.current.data).toHaveLength(1))
    }
  })

  it('keeps two projects apart', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [] }) })

    const a = renderHook(() => useProjectBimModels('proj-1'))
    const b = renderHook(() => useProjectBimModels('proj-2'))
    await waitFor(() => expect(a.result.current.isLoading).toBe(false))
    await waitFor(() => expect(b.result.current.isLoading).toBe(false))

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/projects/proj-1/bim/models',
      '/api/projects/proj-2/bim/models',
    ])
  })

  it('asks again after the shared request has settled', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [] }) })

    const first = renderHook(() => useProjectBimModels('proj-1'))
    await waitFor(() => expect(first.result.current.isLoading).toBe(false))
    // No TTL: a surface mounting later gets a fresh read, so a model that
    // finished extracting in between is not hidden behind a cached answer.
    const second = renderHook(() => useProjectBimModels('proj-1'))
    await waitFor(() => expect(second.result.current.isLoading).toBe(false))

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('makes no request at all without a project', () => {
    renderHook(() => useProjectBimModels(null))

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
