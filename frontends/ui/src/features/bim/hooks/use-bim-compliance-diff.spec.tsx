/**
 * "Did this revision break something."
 *
 * The most expensive question in the product — both revisions read in full —
 * and the only one whose answer an office signs a resubmission against. It is
 * fired by a button rather than by an effect, so React's own cleanup never
 * runs for it: everything that keeps a stale answer off the screen has to be
 * written here, and this spec is what says it is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useBimComplianceDiff } from './use-bim-model'

const NO_FACTS = { gebaeudeklasse: null, hauptnutzung: null }

let fetchMock: ReturnType<typeof vi.fn>

/** A response that resolves only when the test says so. */
function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const ok = (changes: unknown[]) => ({ ok: true, json: async () => ({ complianceChanges: changes }) })

const change = (ruleId: string) => ({ ruleId, trend: 'broken' })

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useBimComplianceDiff', () => {
  it('runs only when asked, not on mount', () => {
    renderHook(() => useBimComplianceDiff('m-new', 'm-old', NO_FACTS))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports the changes the comparison found', async () => {
    fetchMock.mockResolvedValue(ok([change('oib-2-1')]))
    const { result } = renderHook(() => useBimComplianceDiff('m-new', 'm-old', NO_FACTS))

    act(() => result.current.run())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.data?.changes).toEqual([change('oib-2-1')])
  })

  it('discards a result when the revision it compared is no longer the one selected', async () => {
    // The panel captions this result with the base from its CURRENT props
    // ("verglichen mit Haus-A_v2.ifc"). Leaving the numbers standing after the
    // reader switched revisions presents a diff of one pair of files as a diff
    // of another — on the screen whose entire job is to say whether a
    // resubmission broke something.
    fetchMock.mockResolvedValue(ok([change('oib-2-1')]))
    const { result, rerender } = renderHook(
      ({ base }: { base: string }) => useBimComplianceDiff('m-new', base, NO_FACTS),
      { initialProps: { base: 'm-old' } }
    )

    act(() => result.current.run())
    await waitFor(() => expect(result.current.data).not.toBeNull())

    rerender({ base: 'm-older' })
    expect(result.current.data).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it('discards a result when the building facts the rules read change under it', async () => {
    // Gebäudeklasse selects which requirements apply at all, so the same two
    // files produce a different answer. A verdict computed under GK 3 is not
    // a verdict about a GK 4 building.
    fetchMock.mockResolvedValue(ok([change('oib-2-1')]))
    const { result, rerender } = renderHook(
      ({ gk }: { gk: number }) =>
        useBimComplianceDiff('m-new', 'm-old', { gebaeudeklasse: gk, hauptnutzung: null }),
      { initialProps: { gk: 3 } }
    )

    act(() => result.current.run())
    await waitFor(() => expect(result.current.data).not.toBeNull())

    rerender({ gk: 4 })
    expect(result.current.data).toBeNull()
  })

  it('lets the last run win when an earlier one answers later', async () => {
    // This reads both element sets in full, so the slow request is routinely
    // the one started first. Without a ticket the first answer lands last and
    // the panel settles on a comparison nobody asked for.
    const first = deferred()
    const second = deferred()
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const { result } = renderHook(() => useBimComplianceDiff('m-new', 'm-old', NO_FACTS))

    act(() => result.current.run())
    act(() => result.current.run())

    await act(async () => {
      second.resolve(ok([change('second')]))
      await second.promise
    })
    await act(async () => {
      first.resolve(ok([change('first')]))
      await first.promise
    })

    expect(result.current.data?.changes).toEqual([change('second')])
  })

  it('does not report a failure from a run that has been superseded', async () => {
    // The stale request failing must not paint an error over a result that
    // arrived correctly.
    const first = deferred()
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(ok([change('second')]))

    const { result } = renderHook(() => useBimComplianceDiff('m-new', 'm-old', NO_FACTS))
    act(() => result.current.run())
    act(() => result.current.run())
    await waitFor(() => expect(result.current.data).not.toBeNull())

    await act(async () => {
      first.resolve({ ok: false, status: 500, json: async () => ({}) })
      await first.promise.catch(() => undefined)
    })

    expect(result.current.error).toBeNull()
    expect(result.current.data?.changes).toEqual([change('second')])
  })

  it('does nothing when there is no previous revision to compare against', () => {
    const { result } = renderHook(() => useBimComplianceDiff('m-new', null, NO_FACTS))
    act(() => result.current.run())
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
