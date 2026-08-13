/**
 * "Which model is THIS file", asked of the document rather than of a project.
 *
 * Every model surface used to resolve through `/api/projects/<id>/bim/models`,
 * which quietly made a project a prerequisite for looking at a model at all.
 * The org-wide Archiv has no project, so a model uploaded there could not be
 * resolved by anything in the Archiv — the file was parsed, indexed and listed
 * as ready, and the preview beside it said there was no model.
 *
 * Same two guarantees as the project list, because the same surfaces depend on
 * them: one request when several ask at once, and a poll that runs while — and
 * only while — an extraction is still going.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useDocumentBimModel } from './use-bim-model'

let fetchMock: ReturnType<typeof vi.fn>

const answer = (status: string) => ({
  ok: true,
  json: async () => ({ model: { id: 'model-1', documentId: 'doc-1', status } }),
})

/** Deferred so several hooks can mount while the first request is unresolved. */
function pending(): { resolve: () => void; promise: Promise<unknown> } {
  let release: () => void = () => {}
  const promise = new Promise<unknown>((done) => {
    release = () => done(answer('ready'))
  })
  return { resolve: release, promise }
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useDocumentBimModel', () => {
  it('asks the document, not a project', async () => {
    fetchMock.mockResolvedValue(answer('ready'))

    const { result } = renderHook(() => useDocumentBimModel('doc-1'))

    await waitFor(() => expect(result.current.data).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc-1/model', undefined)
  })

  it('asks once when the viewport and the metadata rail ask together', async () => {
    const gate = pending()
    fetchMock.mockReturnValue(gate.promise)

    const viewport = renderHook(() => useDocumentBimModel('doc-1'))
    const rail = renderHook(() => useDocumentBimModel('doc-1'))

    expect(fetchMock).toHaveBeenCalledTimes(1)

    gate.resolve()
    for (const hook of [viewport, rail]) {
      await waitFor(() => expect(hook.result.current.data?.id).toBe('model-1'))
    }
  })

  it('does not ask at all without a document — the project surfaces pass null', () => {
    renderHook(() => useDocumentBimModel(null))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps asking while the model is still being read, and stops when it is', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(answer('extracting'))

    const { result } = renderHook(() => useDocumentBimModel('doc-1'))
    await vi.waitFor(() => expect(result.current.data?.status).toBe('extracting'))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // The minute after an upload: nothing else would tell this surface that
    // extraction finished, so the model would sit at "wird gelesen" until the
    // page was reloaded.
    fetchMock.mockResolvedValue(answer('ready'))
    await vi.advanceTimersByTimeAsync(4_000)
    await vi.waitFor(() => expect(result.current.data?.status).toBe('ready'))

    const afterReady = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(20_000)
    // A ready model costs nothing: the interval is torn down with the flag.
    expect(fetchMock.mock.calls.length).toBe(afterReady)
  })

  it('reports a failed lookup as an error rather than as "there is no model"', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })

    const { result } = renderHook(() => useDocumentBimModel('doc-1'))

    await waitFor(() => expect(result.current.error).toBe('load-failed'))
    expect(result.current.data).toBeNull()
  })
})
