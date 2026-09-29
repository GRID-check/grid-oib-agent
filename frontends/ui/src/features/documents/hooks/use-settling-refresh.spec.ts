import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSettlingRefresh } from './use-settling-refresh'

let visibility: DocumentVisibilityState = 'visible'

function setVisibility(next: DocumentVisibilityState) {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useSettlingRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('asks on the interval while something settles, and stops once nothing does', async () => {
    const refresh = vi.fn(async () => undefined)
    const { rerender } = renderHook(({ items }) => useSettlingRefresh(items, refresh, 1000), {
      initialProps: { items: [{ status: 'processing' }] },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(true)

    rerender({ items: [{ status: 'completed' }] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not ask from a hidden tab, and asks at once when it comes back', async () => {
    const refresh = vi.fn(async () => undefined)
    renderHook(() => useSettlingRefresh([{ status: 'processing' }], refresh, 1000))

    act(() => setVisibility('hidden'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(refresh).not.toHaveBeenCalled()

    await act(async () => {
      setVisibility('visible')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    // And the chain resumes from there.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
