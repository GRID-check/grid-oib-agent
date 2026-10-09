import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FINISH_MAX_MS, MAX_LAG_MS, finishDuration } from '../lib/stream-pace'
import { ARRIVED_AT_MOUNT_CHARS, IDLE_AFTER_MS, MAX_SETTLE_MS, usePacedText, type PacedText } from './use-paced-text'
import { STREAM_FRAMES } from '@/app/dev/_fixtures/stream-frames'

const TEXT = 'Ein zweiter Fluchtweg ist erforderlich, wenn das Fluchtniveau über 11 m liegt. '
const FINAL = `${TEXT}Ausnahmen regelt die OIB-RL 2 für Gebäude der Gebäudeklassen 1 und 2.`
/** One animation frame. */
const FRAME_MS = 16

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('usePacedText', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
  })

  const render = (text: string, streaming: boolean) =>
    renderHook(({ text, streaming }) => usePacedText(text, streaming, true), {
      initialProps: { text, streaming },
    })

  /** Stream `TEXT` until `shown` of it is on screen but not all. */
  const partway = () => {
    const hook = render(TEXT, true)
    act(() => vi.advanceTimersByTime(FRAME_MS * 4))
    expect(hook.result.current.text.length).toBeGreaterThan(0)
    expect(hook.result.current.text.length).toBeLessThan(TEXT.length)
    return hook
  }

  it('shows a finished answer whole and settled at once', () => {
    const { result } = render(TEXT, false)
    expect(result.current).toMatchObject({ text: TEXT, settled: true })
  })

  it('reveals a streaming answer word by word, never more than the ceiling behind', () => {
    const { result } = render(TEXT, true)
    expect(result.current).toMatchObject({ text: '', settled: false })
    const lengths = new Set<number>()
    for (let t = 0; t < MAX_LAG_MS; t += FRAME_MS) {
      act(() => vi.advanceTimersByTime(FRAME_MS))
      lengths.add(result.current.text.length)
      // A word appears whole: the shown text ends at a word gap, or is all of it.
      expect(result.current.text === TEXT || /\s$/.test(result.current.text)).toBe(true)
    }
    expect(lengths.size).toBeGreaterThan(5)
    act(() => vi.advanceTimersByTime(MAX_LAG_MS))
    expect(result.current.text).toBe(TEXT)
    expect(result.current.settled).toBe(false)
  })

  it('is idle only once the reveal has stood still, and not idle again on the next word', () => {
    const { result, rerender } = render(TEXT, true)
    act(() => vi.advanceTimersByTime(FRAME_MS * 4))
    // Words are advancing: the caret stands solid.
    expect(result.current.idle).toBe(false)
    // Everything arrived is shown and nothing more comes: a stall.
    act(() => vi.advanceTimersByTime(MAX_LAG_MS))
    expect(result.current.text).toBe(TEXT)
    act(() => vi.advanceTimersByTime(IDLE_AFTER_MS))
    expect(result.current.idle).toBe(true)
    rerender({ text: FINAL, streaming: true })
    act(() => vi.advanceTimersByTime(FRAME_MS * 20))
    expect(result.current.text.length).toBeGreaterThan(TEXT.length)
    expect(result.current.idle).toBe(false)
  })

  it('keeps the shown length through a rewrite instead of typing it out again', () => {
    const { result, rerender } = render(TEXT, true)
    act(() => vi.advanceTimersByTime(MAX_LAG_MS))
    const before = result.current.text.length
    // The settled snapshot changes a word near the top.
    const settled = TEXT.replace('zweiter', 'weiterer') + 'Ausnahmen regelt die OIB-RL 2. '
    rerender({ text: settled, streaming: true })
    expect(result.current.text.length).toBeGreaterThanOrEqual(before)
    expect(settled.startsWith(result.current.text)).toBe(true)
  })

  it('finishes the held-back words after the turn ends, and settles only when all are shown', () => {
    const { result, rerender } = partway()
    const at = result.current.text.length
    rerender({ text: FINAL, streaming: false })
    // The frame the terminal lands in: nothing jumps, nothing settles.
    expect(result.current).toMatchObject({ text: FINAL.slice(0, at), settled: false })
    const seen: PacedText[] = []
    const duration = finishDuration(FINAL.length - at)
    for (let t = 0; t < duration + FRAME_MS * 2; t += FRAME_MS) {
      act(() => vi.advanceTimersByTime(FRAME_MS))
      seen.push(result.current)
    }
    // It moved in steps, and the answer settled with its last word, not before.
    const partial = seen.filter((s) => s.text.length > at && s.text.length < FINAL.length)
    expect(partial.length).toBeGreaterThan(1)
    for (const s of seen) expect(s.settled).toBe(s.text === FINAL)
    expect(result.current).toMatchObject({ text: FINAL, settled: true })
  })

  it('settles once', () => {
    const settles: boolean[] = []
    const { result, rerender } = partway()
    rerender({ text: FINAL, streaming: false })
    let last = result.current.settled
    for (let t = 0; t < MAX_SETTLE_MS * 2; t += FRAME_MS) {
      act(() => vi.advanceTimersByTime(FRAME_MS))
      if (result.current.settled !== last) settles.push(result.current.settled)
      last = result.current.settled
    }
    expect(settles).toEqual([true])
  })

  it('never takes more than the finish to settle', () => {
    const { result, rerender } = partway()
    rerender({ text: FINAL.repeat(20), streaming: false })
    act(() => vi.advanceTimersByTime(FINISH_MAX_MS + FRAME_MS * 2))
    expect(result.current.settled).toBe(true)
  })

  it('settles at once when the terminal does not continue what is shown', () => {
    const { result, rerender } = partway()
    const rewritten = FINAL.replace('Ein zweiter', 'Der zweite')
    rerender({ text: rewritten, streaming: false })
    expect(result.current).toMatchObject({ text: rewritten, settled: true })
  })

  it('settles at once when the terminal is shorter than what is shown', () => {
    const { result, rerender } = partway()
    rerender({ text: 'Ein', streaming: false })
    expect(result.current).toMatchObject({ text: 'Ein', settled: true })
  })

  it('settles at once on a hidden page, where no frame would come', () => {
    const { rerender, result } = partway()
    setVisibility('hidden')
    rerender({ text: FINAL, streaming: false })
    expect(result.current).toMatchObject({ text: FINAL, settled: true })
  })

  it('settles when the page is hidden during the finish', () => {
    const { rerender, result } = partway()
    rerender({ text: FINAL, streaming: false })
    act(() => vi.advanceTimersByTime(FRAME_MS))
    expect(result.current.settled).toBe(false)
    act(() => setVisibility('hidden'))
    expect(result.current).toMatchObject({ text: FINAL, settled: true })
  })

  it('settles on a timer when the frames stop', () => {
    const { rerender, result } = partway()
    // From here on no frame is ever delivered.
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    rerender({ text: FINAL, streaming: false })
    act(() => vi.advanceTimersByTime(MAX_SETTLE_MS - FRAME_MS * 10))
    expect(result.current.settled).toBe(false)
    act(() => vi.advanceTimersByTime(FRAME_MS * 20))
    expect(result.current).toMatchObject({ text: FINAL, settled: true })
    raf.mockRestore()
  })

  it('shows everything, settled with the turn, when it is disabled', () => {
    const { result, rerender } = renderHook(({ streaming }) => usePacedText(TEXT, streaming, false), {
      initialProps: { streaming: true },
    })
    expect(result.current).toMatchObject({ text: TEXT, settled: false })
    rerender({ streaming: false })
    expect(result.current).toMatchObject({ text: TEXT, settled: true })
  })

  // The ratchet for the audit's first finding: over the two recorded answers,
  // with their settled snapshot and their terminal rewriting the prose, what
  // the reader sees never shrinks, and the finished answer lands whole at the
  // end of the short finish after the terminal, where the answer settles.
  it.each(Object.keys(STREAM_FRAMES) as (keyof typeof STREAM_FRAMES)[])(
    'never takes back text it showed over the recorded %s answer, and lands it whole',
    (name) => {
      const { frames } = STREAM_FRAMES[name]
      const { result, rerender } = render('', true)
      let text = ''
      let shown = 0
      let at = frames[0]!.t
      const step = (ms: number) => {
        for (let t = 0; t < ms; t += FRAME_MS) {
          act(() => vi.advanceTimersByTime(Math.min(FRAME_MS, ms - t)))
          const now = result.current.text.length
          expect(now).toBeGreaterThanOrEqual(Math.min(shown, text.length))
          expect(text.startsWith(result.current.text)).toBe(true)
          shown = now
        }
      }
      for (const frame of frames) {
        step(Math.max(0, (frame.t - at) * 1000))
        at = frame.t
        const done = frame.status === 'complete'
        if (done || frame.stream_replace) text = frame.content
        else text += frame.content
        rerender({ text, streaming: !done })
        expect(result.current.text.length).toBeGreaterThanOrEqual(Math.min(shown, text.length))
        shown = result.current.text.length
        expect(result.current.settled).toBe(done && result.current.text === text)
      }
      step(FINISH_MAX_MS + FRAME_MS)
      expect(result.current).toMatchObject({ text, settled: true })
    }
  )
})

describe('usePacedText after Stop', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const STREAMED = 'Ein zweiter Fluchtweg ist erforderlich, wenn das Fluchtniveau über 11 m liegt. '

  it('settles at what is shown and does not type out the held-back rest', () => {
    const { result, rerender } = renderHook(
      ({ text, streaming, stopped }) => usePacedText(text, streaming, true, stopped),
      { initialProps: { text: STREAMED, streaming: true, stopped: false } }
    )
    act(() => vi.advanceTimersByTime(16 * 4))
    const atStop = result.current.text
    expect(atStop.length).toBeGreaterThan(0)
    expect(atStop.length).toBeLessThan(STREAMED.length)

    rerender({ text: STREAMED, streaming: false, stopped: true })
    expect(result.current).toMatchObject({ text: atStop, settled: true })
    act(() => vi.advanceTimersByTime(MAX_SETTLE_MS))
    expect(result.current.text).toBe(atStop)
  })

  it("holds the shown text when the cancelled terminal brings the server's longer one", () => {
    const { result, rerender } = renderHook(
      ({ text, streaming, stopped }) => usePacedText(text, streaming, true, stopped),
      { initialProps: { text: STREAMED, streaming: true, stopped: false } }
    )
    act(() => vi.advanceTimersByTime(16 * 4))
    const atStop = result.current.text
    rerender({ text: STREAMED, streaming: false, stopped: true })
    rerender({ text: `${STREAMED}Und noch ein Satz, den niemand gesehen hat.`, streaming: false, stopped: true })
    expect(result.current.text).toBe(atStop)
  })

  it('shows a stopped answer that mounts finished whole', () => {
    const { result } = renderHook(() => usePacedText(STREAMED, false, true, true))
    expect(result.current).toMatchObject({ text: STREAMED, settled: true })
  })
})

// L27, L28: an answer that mounts in the middle of its turn with its text
// already there (a reload's replay, a thread opened again) shows that text at
// once and paces only what arrives after.
describe('usePacedText, mounting mid-turn', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const SENTENCE = 'Ein zweiter Fluchtweg ist erforderlich, wenn das Fluchtniveau über 11 m liegt. '
  const LONG = SENTENCE.repeat(Math.ceil(2000 / SENTENCE.length))

  it('shows 2000 characters that had already arrived at once, and paces only the next delta', () => {
    expect(LONG.length).toBeGreaterThan(ARRIVED_AT_MOUNT_CHARS)
    const { result, rerender } = renderHook(({ text }) => usePacedText(text, true, true), {
      initialProps: { text: LONG },
    })
    expect(result.current).toMatchObject({ text: LONG, settled: false })

    rerender({ text: `${LONG}${SENTENCE}` })
    expect(result.current.text).toBe(LONG)
    act(() => vi.advanceTimersByTime(16 * 4))
    expect(result.current.text.length).toBeGreaterThan(LONG.length)
  })

  it('starts a fresh answer from its first word', () => {
    const { result } = renderHook(() => usePacedText(SENTENCE, true, true, false, 'fresh'))
    expect(result.current.text).toBe('')
  })

  // A fresh answer is born with its masthead's summary whole, ahead of the
  // first prose words: the head does not make it a turn joined mid-way.
  const SUMMARY = `${'Für ein konkretes Vorhaben ist zuerst der passende Teil zu bestimmen. '.repeat(5)}\n\n`

  it('paces a fresh answer born with a long written-in head from its first word', () => {
    const text = `${SUMMARY}${SENTENCE}`
    expect(text.length).toBeGreaterThan(ARRIVED_AT_MOUNT_CHARS)
    expect(SENTENCE.length).toBeLessThan(ARRIVED_AT_MOUNT_CHARS)
    const { result } = renderHook(() => usePacedText(text, true, true, false, 'headed', SUMMARY.length))
    expect(result.current.text).toBe('')
    // Written in, not dumped: a word at first, the whole head within the lag ceiling.
    act(() => vi.advanceTimersByTime(16))
    expect(result.current.text.length).toBeGreaterThan(0)
    expect(result.current.text.length).toBeLessThan(SUMMARY.length)
    act(() => vi.advanceTimersByTime(MAX_LAG_MS))
    expect(result.current.text).toBe(text)
  })

  it('still shows a headed answer joined mid-way at once', () => {
    const text = `${SUMMARY}${LONG}`
    const { result } = renderHook(() => usePacedText(text, true, true, false, 'headed-late', SUMMARY.length))
    expect(result.current.text).toBe(text)
  })

  it('shows what a remounted answer had on screen at once, however short', () => {
    const first = renderHook(() => usePacedText(SENTENCE, true, true, false, 'switched'))
    act(() => vi.advanceTimersByTime(16 * 4))
    first.unmount()

    const again = renderHook(() => usePacedText(SENTENCE, true, true, false, 'switched'))
    expect(again.result.current.text).toBe(SENTENCE)
  })

  it('forgets an answer once it has settled', () => {
    const first = renderHook(({ streaming }) => usePacedText(SENTENCE, streaming, true, false, 'settles'), {
      initialProps: { streaming: true },
    })
    first.rerender({ streaming: false })
    act(() => vi.advanceTimersByTime(MAX_SETTLE_MS))
    expect(first.result.current.settled).toBe(true)
    first.unmount()

    const next = renderHook(() => usePacedText(SENTENCE, true, true, false, 'settles'))
    expect(next.result.current.text).toBe('')
  })
})
