import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useCopyToClipboard } from './use-copy-to-clipboard'

describe('useCopyToClipboard', () => {
  let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>

  beforeEach(() => {
    vi.useFakeTimers()
    writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test('copies, acknowledges, and drops the acknowledgement after 1.5 s', async () => {
    const { result } = renderHook(() => useCopyToClipboard())

    let ok = false
    await act(async () => {
      ok = await result.current.copy('abc')
    })

    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith('abc')
    expect(result.current.copied).toBe(true)

    act(() => vi.advanceTimersByTime(1500))
    expect(result.current.copied).toBe(false)
  })

  test('a refused copy resolves false and never acknowledges', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const { result } = renderHook(() => useCopyToClipboard())

    let ok = true
    await act(async () => {
      ok = await result.current.copy('abc')
    })

    expect(ok).toBe(false)
    expect(result.current.copied).toBe(false)
  })

  test('a second copy restarts the acknowledgement instead of cutting it short', async () => {
    const { result } = renderHook(() => useCopyToClipboard())

    await act(async () => {
      await result.current.copy('a')
    })
    act(() => vi.advanceTimersByTime(1000))
    await act(async () => {
      await result.current.copy('b')
    })
    act(() => vi.advanceTimersByTime(1000))

    expect(result.current.copied).toBe(true)
  })

  test('unmounting clears the pending timer', async () => {
    const clearTimeout = vi.spyOn(window, 'clearTimeout')
    const { result, unmount } = renderHook(() => useCopyToClipboard())

    await act(async () => {
      await result.current.copy('abc')
    })
    unmount()

    expect(clearTimeout).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
