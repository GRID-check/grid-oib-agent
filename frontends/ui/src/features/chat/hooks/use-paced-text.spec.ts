import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_LAG_MS, PACE_TICK_MS } from '../lib/stream-pace'
import { usePacedText } from './use-paced-text'

const TEXT = 'Ein zweiter Fluchtweg ist erforderlich, wenn das Fluchtniveau über 11 m liegt. '

describe('usePacedText', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const render = (text: string, streaming: boolean) =>
    renderHook(({ text, streaming }) => usePacedText(text, streaming, true), {
      initialProps: { text, streaming },
    })

  it('shows a finished answer whole at once', () => {
    const { result } = render(TEXT, false)
    expect(result.current).toBe(TEXT)
  })

  it('reveals a streaming answer over several steps, never more than the ceiling behind', () => {
    const { result } = render(TEXT, true)
    expect(result.current).toBe('')
    act(() => vi.advanceTimersByTime(PACE_TICK_MS * 2))
    const early = result.current.length
    expect(early).toBeGreaterThan(0)
    expect(early).toBeLessThan(TEXT.length)
    act(() => vi.advanceTimersByTime(MAX_LAG_MS))
    expect(result.current).toBe(TEXT)
  })

  it('keeps what a replacement shares with what is shown', () => {
    const { result, rerender } = render(TEXT, true)
    act(() => vi.advanceTimersByTime(MAX_LAG_MS))
    rerender({ text: 'Ein zweiter Fluchtweg ist nicht erforderlich.', streaming: true })
    expect(result.current.startsWith('Ein zweiter Fluchtweg ist ')).toBe(true)
  })

  it('shows everything as soon as it is disabled', () => {
    const { result } = renderHook(() => usePacedText(TEXT, true, false))
    expect(result.current).toBe(TEXT)
  })
})
