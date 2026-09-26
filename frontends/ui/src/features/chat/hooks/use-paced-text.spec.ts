import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_LAG_MS, PACE_TICK_MS } from '../lib/stream-pace'
import { usePacedText } from './use-paced-text'
import { STREAM_FRAMES } from '@/app/dev/_fixtures/stream-frames'

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

  it('keeps the shown length through a rewrite instead of typing it out again', () => {
    const { result, rerender } = render(TEXT, true)
    act(() => vi.advanceTimersByTime(MAX_LAG_MS))
    const before = result.current.length
    // The settled snapshot changes a word near the top.
    const settled = TEXT.replace('zweiter', 'weiterer') + 'Ausnahmen regelt die OIB-RL 2. '
    rerender({ text: settled, streaming: true })
    expect(result.current.length).toBeGreaterThanOrEqual(before)
    expect(settled.startsWith(result.current)).toBe(true)
  })

  it('shows the finished answer whole the moment the turn ends', () => {
    const { result, rerender } = render(TEXT, true)
    act(() => vi.advanceTimersByTime(PACE_TICK_MS))
    expect(result.current.length).toBeLessThan(TEXT.length)
    const final = TEXT + 'Ausnahmen regelt die OIB-RL 2.'
    rerender({ text: final, streaming: false })
    expect(result.current).toBe(final)
  })

  it('shows everything as soon as it is disabled', () => {
    const { result } = renderHook(() => usePacedText(TEXT, true, false))
    expect(result.current).toBe(TEXT)
  })

  // The ratchet for the audit's first finding: over the two recorded answers,
  // with their settled snapshot and their terminal rewriting the prose, what
  // the reader sees never shrinks, and the finished answer lands in one step.
  it.each(Object.keys(STREAM_FRAMES) as (keyof typeof STREAM_FRAMES)[])(
    'never takes back text it showed over the recorded %s answer',
    (name) => {
      const { frames } = STREAM_FRAMES[name]
      const { result, rerender } = render('', true)
      let text = ''
      let shown = 0
      let at = frames[0]!.t
      for (const frame of frames) {
        act(() => vi.advanceTimersByTime(Math.max(0, (frame.t - at) * 1000)))
        at = frame.t
        const done = frame.status === 'complete'
        if (done || frame.stream_replace) text = frame.content
        else text += frame.content
        rerender({ text, streaming: !done })
        const now = result.current.length
        expect(now).toBeGreaterThanOrEqual(Math.min(shown, text.length))
        shown = now
        if (done) expect(result.current).toBe(text)
      }
    }
  )
})
