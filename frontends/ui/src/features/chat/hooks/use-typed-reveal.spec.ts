/**
 * The reveal, driven by a hand-cranked frame clock.
 *
 * `requestAnimationFrame` is replaced rather than faked with timers: the hook
 * reads the timestamp the browser hands the callback, so a spec that only
 * advanced a clock would advance nothing. Each `frame(ms)` call runs exactly
 * the callbacks queued at that point, with the timestamp the spec chooses.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTypedReveal } from './use-typed-reveal'

let queued: FrameRequestCallback[] = []
let nextHandle = 1

const frame = (timestamp: number) => {
  const due = queued
  queued = []
  act(() => {
    for (const callback of due) callback(timestamp)
  })
}

beforeEach(() => {
  queued = []
  nextHandle = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queued.push(callback)
    return nextHandle++
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useTypedReveal', () => {
  it('shows an answer that mounted complete, without typing it', () => {
    // A thread scrolled back to. Every answer in it is finished; a history that
    // types itself out again on every mount is a bug, not an effect.
    const { result } = renderHook(() => useTypedReveal('Ein fertiger Absatz.', { paced: true }))

    expect(result.current.text).toBe('Ein fertiger Absatz.')
    expect(result.current.isTyping).toBe(false)
    expect(queued).toHaveLength(0)
  })

  it('lags text that arrives after mount, then catches up', () => {
    const answer = 'a'.repeat(600)
    const { result, rerender } = renderHook(
      ({ content }) => useTypedReveal(content, { paced: true }),
      { initialProps: { content: '' } }
    )

    // The whole answer lands in one frame, which is what the backend actually
    // does: it cuts a FINISHED reply into deltas and yields them at once.
    rerender({ content: answer })
    expect(result.current.isTyping).toBe(true)
    expect(result.current.text).toBe('')

    frame(0)
    frame(100)
    expect(result.current.text.length).toBeGreaterThan(0)
    expect(result.current.text.length).toBeLessThan(answer.length)
    expect(answer.startsWith(result.current.text)).toBe(true)

    // The rate is a DRAIN: 600 characters over ~2s, so a second in it is past
    // the halfway mark and the whole thing is done inside the budget.
    frame(2100)
    expect(result.current.text).toBe(answer)
    expect(result.current.isTyping).toBe(false)
  })

  it('finishes a long report in the same budget as a short answer', () => {
    // The property the deadline buys. Setting the rate from the backlog alone
    // decays — the closer it gets the slower it goes — and a report this long
    // trailed for seven seconds behind a caret.
    const report = 'x'.repeat(6000)
    const { result, rerender } = renderHook(
      ({ content }) => useTypedReveal(content, { paced: true }),
      { initialProps: { content: '' } }
    )

    rerender({ content: report })
    for (let elapsed = 0; elapsed <= 2000; elapsed += 16) frame(elapsed)

    expect(result.current.text).toBe(report)
    expect(result.current.isTyping).toBe(false)
  })

  it('reveals a short answer at the floor rather than instantly', () => {
    const answer = 'Ja, ab GK4 ist ein zweiter Fluchtweg gefordert.'
    const { result, rerender } = renderHook(
      ({ content }) => useTypedReveal(content, { paced: true }),
      { initialProps: { content: '' } }
    )

    rerender({ content: answer })
    frame(0)
    frame(16)
    // 220 chars/s over one frame is ~4 characters — visibly written, not a pop.
    expect(result.current.text.length).toBeLessThan(answer.length)
    expect(result.current.text.length).toBeGreaterThan(0)
  })

  it('reveals at most about thirty times a second', () => {
    // Each reveal re-parses the answer as markdown. At the display's full rate
    // that bill is paid twice as often for no visible gain.
    const answer = 'a'.repeat(600)
    const { result, rerender } = renderHook(
      ({ content }) => useTypedReveal(content, { paced: true }),
      { initialProps: { content: '' } }
    )

    rerender({ content: answer })
    frame(0)
    const afterFirst = result.current.text
    frame(16)
    expect(result.current.text).toBe(afterFirst)
    frame(40)
    expect(result.current.text.length).toBeGreaterThan(afterFirst.length)
  })

  it('snaps when the text is replaced rather than extended', () => {
    // The terminal frame swaps the accumulated text for the authoritative
    // answer, and a session swap hands the same component a different one.
    // Neither is something to type out.
    const { result, rerender } = renderHook(
      ({ content }) => useTypedReveal(content, { paced: true }),
      { initialProps: { content: '' } }
    )

    rerender({ content: 'Der erste Entwurf' })
    frame(0)
    frame(16)
    expect(result.current.isTyping).toBe(true)

    rerender({ content: 'Eine ganz andere Antwort' })
    expect(result.current.text).toBe('Eine ganz andere Antwort')
    expect(result.current.isTyping).toBe(false)
  })

  it('never cuts a surrogate pair in half', () => {
    // A lone surrogate renders as a replacement glyph for a frame. `slice`
    // counts code units, so the boundary has to be stepped back onto.
    const answer = `${'x'.repeat(300)}🏗️${'y'.repeat(300)}`
    const { result, rerender } = renderHook(
      ({ content }) => useTypedReveal(content, { paced: true }),
      { initialProps: { content: '' } }
    )

    rerender({ content: answer })
    for (let elapsed = 0; elapsed <= 2100; elapsed += 16) {
      frame(elapsed)
      expect(result.current.text).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(answer.startsWith(result.current.text)).toBe(true)
    }
    expect(result.current.text).toBe(answer)
  })

  it('shows everything at once when pacing is off', () => {
    // `prefers-reduced-motion`, a server render, and every spec that asserts on
    // a rendered answer all land here.
    const { result, rerender } = renderHook(
      ({ content }) => useTypedReveal(content, { paced: false }),
      { initialProps: { content: '' } }
    )

    rerender({ content: 'Sofort vollständig.' })
    expect(result.current.text).toBe('Sofort vollständig.')
    expect(result.current.isTyping).toBe(false)
    expect(queued).toHaveLength(0)
  })
})
