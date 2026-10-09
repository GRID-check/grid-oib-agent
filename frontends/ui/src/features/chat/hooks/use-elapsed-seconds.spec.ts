import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { formatElapsed, useElapsedSeconds } from './use-elapsed-seconds'

describe('useElapsedSeconds', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-09T08:00:30.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  test('counts from `since`, so a late mount shows the true figure at once', () => {
    const { result } = renderHook(() => useElapsedSeconds(true, new Date('2026-10-09T08:00:00.000Z')))
    expect(result.current).toBe(30)
    act(() => vi.advanceTimersByTime(2000))
    expect(result.current).toBe(32)
  })

  test('takes an ISO string, as a restored message carries it', () => {
    const { result } = renderHook(() => useElapsedSeconds(true, '2026-10-09T08:00:20.000Z'))
    expect(result.current).toBe(10)
  })

  test('without `since` it counts from activation', () => {
    const { result } = renderHook(() => useElapsedSeconds(true))
    expect(result.current).toBe(0)
    act(() => vi.advanceTimersByTime(3000))
    expect(result.current).toBe(3)
  })

  test('is 0 while inactive', () => {
    const { result } = renderHook(() => useElapsedSeconds(false, new Date('2026-10-09T08:00:00.000Z')))
    expect(result.current).toBe(0)
  })

  test('freezes on its last figure when it goes inactive', () => {
    const { result, rerender } = renderHook(({ active }) => useElapsedSeconds(active), {
      initialProps: { active: true },
    })
    act(() => vi.advanceTimersByTime(5000))
    rerender({ active: false })
    act(() => vi.advanceTimersByTime(5000))
    expect(result.current).toBe(5)
  })

  test('formats under and over a minute', () => {
    expect(formatElapsed(9)).toBe('9s')
    expect(formatElapsed(65)).toBe('1:05')
  })
})
