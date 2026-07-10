import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useConnectionPresence } from './use-connection-presence'

/**
 * `navigator.onLine` is a read-only getter, so we back it with a mutable
 * variable and redefine the property before each test. `setOnline` both flips
 * the value and dispatches the matching window event, mirroring how a real
 * browser signals a connectivity change.
 */
let onlineValue = true

function setOnline(value: boolean, event: 'online' | 'offline'): void {
  onlineValue = value
  window.dispatchEvent(new Event(event))
}

beforeEach(() => {
  onlineValue = true
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => onlineValue,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useConnectionPresence — navigator.onLine transitions', () => {
  test('starts in the optimistic connected state', () => {
    const { result } = renderHook(() => useConnectionPresence({ enablePing: false }))
    expect(result.current).toBe('connected')
  })

  test('transitions to offline after the offline event, once the debounce elapses', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() =>
      useConnectionPresence({ enablePing: false, debounceMs: 100 }),
    )

    act(() => {
      setOnline(false, 'offline')
    })
    // Held during the debounce window.
    expect(result.current).toBe('connected')

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current).toBe('offline')
  })

  test('returns to connected when connectivity is restored', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() =>
      useConnectionPresence({ enablePing: false, debounceMs: 100 }),
    )

    act(() => {
      setOnline(false, 'offline')
      vi.advanceTimersByTime(100)
    })
    expect(result.current).toBe('offline')

    act(() => {
      setOnline(true, 'online')
      vi.advanceTimersByTime(100)
    })
    expect(result.current).toBe('connected')
  })

  test('does not flap on a blip shorter than the debounce window', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() =>
      useConnectionPresence({ enablePing: false, debounceMs: 300 }),
    )

    act(() => {
      setOnline(false, 'offline')
      vi.advanceTimersByTime(150) // less than debounceMs
      setOnline(true, 'online')
      vi.advanceTimersByTime(300)
    })

    // The transient offline never committed.
    expect(result.current).toBe('connected')
  })
})

describe('useConnectionPresence — health ping', () => {
  test('reports reconnecting when the health ping fails while online', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))

    const { result } = renderHook(() =>
      useConnectionPresence({ debounceMs: 0, pingIntervalMs: 100_000 }),
    )

    await waitFor(() => expect(result.current).toBe('reconnecting'))
  })

  test('stays connected when the health ping succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() =>
      useConnectionPresence({ debounceMs: 0, pingIntervalMs: 100_000 }),
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(result.current).toBe('connected')
  })

  test('does not ping while offline', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    onlineValue = false

    renderHook(() => useConnectionPresence({ debounceMs: 0, pingIntervalMs: 100_000 }))

    // Give any queued microtasks/effects a chance to run.
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
