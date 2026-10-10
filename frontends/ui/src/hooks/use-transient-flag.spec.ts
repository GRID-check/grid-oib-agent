import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUSY_REVEAL_DELAY_MS, TRANSIENT_FLAG_MS, useDelayedFlag, useTransientFlag } from './use-transient-flag'

describe('useTransientFlag', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('turns itself off after the hold', () => {
    const { result } = renderHook(() => useTransientFlag())
    act(() => result.current[1]())
    expect(result.current[0]).toBe(true)
    act(() => vi.advanceTimersByTime(TRANSIENT_FLAG_MS))
    expect(result.current[0]).toBe(false)
  })

  it('restarts the window on a second raise instead of racing the first', () => {
    const { result } = renderHook(() => useTransientFlag())
    act(() => result.current[1]())
    act(() => vi.advanceTimersByTime(TRANSIENT_FLAG_MS - 100))
    act(() => result.current[1]())
    // The first raise's timeout would have fired here.
    act(() => vi.advanceTimersByTime(200))
    expect(result.current[0]).toBe(true)
    act(() => vi.advanceTimersByTime(TRANSIENT_FLAG_MS))
    expect(result.current[0]).toBe(false)
  })

  it('leaves no timer behind on unmount', () => {
    const { result, unmount } = renderHook(() => useTransientFlag())
    act(() => result.current[1]())
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('useDelayedFlag', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stays false for a wait shorter than the reveal delay', () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active), {
      initialProps: { active: true },
    })
    act(() => vi.advanceTimersByTime(BUSY_REVEAL_DELAY_MS - 1))
    expect(result.current).toBe(false)
    rerender({ active: false })
    act(() => vi.advanceTimersByTime(BUSY_REVEAL_DELAY_MS))
    expect(result.current).toBe(false)
  })

  it('turns on once the wait outlasts the delay, and off with it', () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active), {
      initialProps: { active: true },
    })
    act(() => vi.advanceTimersByTime(BUSY_REVEAL_DELAY_MS))
    expect(result.current).toBe(true)
    rerender({ active: false })
    expect(result.current).toBe(false)
  })
})
