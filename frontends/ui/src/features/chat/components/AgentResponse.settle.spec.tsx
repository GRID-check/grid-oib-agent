/**
 * The end of a turn, as the answer draws it: the text still held back is
 * finished first, and only when all of it is on screen does the answer settle.
 * Then everything that belongs to a finished answer lands together (the copy
 * action, the caret gone) and the reveal signal the Herleitung's collapse waits
 * on (`answer-reveal-store.ts`) ends, once.
 *
 * The pace is switched on here (it is off under vitest by default), and the
 * clock is faked, frames included.
 */
import { act, render, screen } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { ChatStoreWithHydration } from '../store'
import { useAnswerRevealStore } from '../stores/answer-reveal-store'
import { IDLE_AFTER_MS } from '../hooks/use-paced-text'
import { AgentResponse } from './AgentResponse'

vi.mock('../hooks/use-paced-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-paced-text')>()
  return {
    ...actual,
    usePacedText: (
      text: string,
      streaming: boolean,
      _enabled?: boolean,
      stopped?: boolean,
      id?: string,
      leadChars?: number
    ) => actual.usePacedText(text, streaming, true, stopped, id, leadChars),
  }
})

vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: StoreSelector<ChatStoreWithHydration>) => {
    const state: DeepPartial<ChatStoreWithHydration> = {
      currentConversation: null,
      projectId: null,
      patchConversationMessage: vi.fn(),
    }
    return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
  }),
}))

vi.mock('@/adapters/auth', () => ({ useAuth: () => ({ accessToken: null }) }))

// The prose as plain text, so what is shown can be read off the DOM exactly.
// The caret where the renderer would place it: after the last word.
// Every plugin list the renderer was handed, by identity: a new list re-parses
// the whole answer.
const pluginLists = new Set<unknown>()
vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({
    content,
    caret,
    remarkPlugins,
  }: {
    content: string
    caret?: React.ReactNode
    remarkPlugins?: unknown
  }) => {
    pluginLists.add(remarkPlugins)
    return (
      <span data-testid="prose">
        {content}
        {caret}
      </span>
    )
  },
}))

const FRAME_MS = 16
const STREAMED = 'Ein zweiter Fluchtweg ist erforderlich, wenn das Fluchtniveau über 11 m liegt. '
const FINAL = `${STREAMED}Ausnahmen regelt die OIB-RL 2 für Gebäude der Gebäudeklassen 1 und 2.`

const answer = (content: string, isStreaming: boolean) => (
  <AgentResponse content={content} isStreaming={isStreaming} messageId="m-1" showAnswerFeedback={false} />
)

describe('the end of a streamed answer', () => {
  let signal: (string | null)[]
  let unsubscribe: () => void

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    })
    useAnswerRevealStore.setState({ revealingId: null })
    signal = []
    unsubscribe = useAnswerRevealStore.subscribe((s, prev) => {
      if (s.revealingId !== prev.revealingId) signal.push(s.revealingId)
    })
  })
  afterEach(() => {
    unsubscribe()
    vi.useRealTimers()
  })

  it('settles only after the reveal reaches the end, and signals the settle once', () => {
    const { rerender } = render(answer(STREAMED, true))
    act(() => vi.advanceTimersByTime(FRAME_MS * 6))
    expect(useAnswerRevealStore.getState().revealingId).toBe('m-1')

    rerender(answer(FINAL, false))
    const steps: { shown: string; copy: boolean; revealing: boolean }[] = []
    const look = () =>
      steps.push({
        shown: screen.getByTestId('prose').textContent ?? '',
        copy: screen.queryByRole('button', { name: 'Copy answer' }) !== null,
        revealing: useAnswerRevealStore.getState().revealingId === 'm-1',
      })
    look()
    for (let t = 0; t < 1500; t += FRAME_MS) {
      act(() => vi.advanceTimersByTime(FRAME_MS))
      look()
    }

    // The frame the terminal lands in shows no more than before, and nothing settled.
    expect(steps[0]!.shown.length).toBeLessThan(FINAL.length)
    expect(steps[0]!.copy).toBe(false)
    // The rest came in steps, not at once.
    expect(new Set(steps.map((s) => s.shown.length)).size).toBeGreaterThan(3)
    // Whatever belongs to the finished answer is there exactly when all the text is.
    for (const step of steps) {
      expect(step.copy).toBe(step.shown === FINAL)
      expect(step.revealing).toBe(step.shown !== FINAL)
    }
    expect(steps.at(-1)!.shown).toBe(FINAL)
    // One reveal, begun once and ended once.
    expect(signal).toEqual(['m-1', null])
  })

  it('settles at once when all the prose is shown and the terminal only adds its sources', () => {
    const { rerender } = render(answer(STREAMED, true))
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByTestId('prose').textContent).toBe(STREAMED)
    // The written sources section is lifted into the source rows, never drawn
    // as text: there is nothing left to reveal.
    rerender(answer(`${STREAMED}\n\n## Quellen\n\n1. OIB-Richtlinie 2, Ausgabe Mai 2023`, false))
    expect(screen.getByRole('button', { name: /Copy answer/ })).toBeInTheDocument()
    expect(useAnswerRevealStore.getState().revealingId).toBeNull()
    expect(signal).toEqual(['m-1', null])
  })

  it('never signals a reveal for an answer that mounts finished', () => {
    render(answer(FINAL, false))
    act(() => vi.advanceTimersByTime(FRAME_MS * 4))
    expect(signal).toEqual([])
    expect(screen.getByRole('button', { name: 'Copy answer' })).toBeInTheDocument()
  })

  it('hands the renderer a caret that stands solid while words advance and breathes in a pause', () => {
    const { rerender } = render(answer(STREAMED, true))
    act(() => vi.advanceTimersByTime(FRAME_MS * 6))
    const caret = () => screen.queryByTestId('streaming-caret')
    // Inside the prose, not after it: no wrapper is forced inline to trail it.
    expect(screen.getByTestId('prose')).toContainElement(caret())
    expect(caret()?.closest('[class*=":inline"]')).toBeNull()
    expect(caret()).not.toHaveAttribute('data-idle')
    // Everything that arrived is shown and nothing more comes.
    act(() => vi.advanceTimersByTime(3000))
    act(() => vi.advanceTimersByTime(IDLE_AFTER_MS))
    expect(caret()).toHaveAttribute('data-idle', 'true')
    rerender(answer(FINAL, false))
    act(() => vi.advanceTimersByTime(1500))
    expect(caret()).toBeNull()
  })

  it('ends the reveal when the answer goes away mid-stream', () => {
    const { unmount } = render(answer(STREAMED, true))
    expect(useAnswerRevealStore.getState().revealingId).toBe('m-1')
    unmount()
    expect(useAnswerRevealStore.getState().revealingId).toBeNull()
  })

  it('hands the renderer the same plugin list from the first word through the settle', () => {
    pluginLists.clear()
    const { rerender } = render(answer(STREAMED, true))
    act(() => vi.advanceTimersByTime(FRAME_MS * 6))
    rerender(answer(FINAL, false))
    act(() => vi.advanceTimersByTime(1500))
    expect(screen.getByTestId('prose').textContent).toBe(FINAL)
    // The settle frame is the answer's most expensive; it re-parses nothing.
    expect(pluginLists.size).toBe(1)
  })

  it('holds the copy actions in the row while live, unseen and inert, and hands them over at the settle', () => {
    const { rerender } = render(answer(STREAMED, true))
    act(() => vi.advanceTimersByTime(FRAME_MS * 6))
    const held = document.querySelector('[aria-label="Copy answer"]')
    expect(held).not.toBeNull()
    expect(held?.closest('[inert]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy answer' })).toBeNull()

    rerender(answer(FINAL, false))
    act(() => vi.advanceTimersByTime(1500))
    // The same button, now there for the reader: nothing was inserted.
    expect(screen.getByRole('button', { name: 'Copy answer' })).toBe(held)
    expect(held?.closest('[inert]')).toBeNull()
  })

  // The footer's room: a card that fits the viewport shows no empty band of
  // shell under its first words; the footer opens at the settle, below them.
  it('keeps no room for the footer while the answer fits the viewport, and opens it at the settle', () => {
    const { rerender } = render(answer(STREAMED, true))
    act(() => vi.advanceTimersByTime(FRAME_MS * 6))
    const room = () => screen.getByTestId('answer-footer').parentElement
    expect(room()).toHaveAttribute('data-open', 'false')
    rerender(answer(FINAL, false))
    act(() => vi.advanceTimersByTime(1500))
    expect(room()).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('answer-footer')).not.toHaveClass('invisible')
  })

  it('keeps the footer room, unseen, once the answer reaches below the viewport', () => {
    const below = window.innerHeight + 200
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ top: 0, bottom: below, left: 0, right: 0, width: 0, height: below, x: 0, y: 0, toJSON: () => ({}) })
    try {
      render(answer(STREAMED, true))
      expect(screen.getByTestId('answer-footer').parentElement).toHaveAttribute('data-open', 'true')
      expect(screen.getByTestId('answer-footer')).toHaveClass('invisible')
    } finally {
      rect.mockRestore()
    }
  })

  it('claims completeness only once settled: a dot on the role tab while live, the check after', () => {
    const { rerender } = render(answer(STREAMED, true))
    expect(screen.getByTestId('role-tab-pending')).toBeInTheDocument()
    expect(screen.getByRole('article')).toHaveAttribute('aria-busy', 'true')
    rerender(answer(FINAL, false))
    act(() => vi.advanceTimersByTime(1500))
    expect(screen.queryByTestId('role-tab-pending')).toBeNull()
    expect(screen.getByRole('article')).not.toHaveAttribute('aria-busy')
    expect(screen.getByRole('article')).toHaveAccessibleName('Result')
  })

  it('after Stop, keeps what was on screen, says so, and does not claim to be complete', () => {
    const { rerender } = render(answer(STREAMED, true))
    act(() => vi.advanceTimersByTime(FRAME_MS * 4))
    const atStop = screen.getByTestId('prose').textContent ?? ''
    expect(atStop.length).toBeLessThan(STREAMED.length)

    const stoppedAnswer = (content: string) => (
      <AgentResponse content={content} messageId="m-1" showAnswerFeedback={false} stopped />
    )
    rerender(stoppedAnswer(STREAMED))
    expect(screen.getByTestId('prose').textContent).toBe(atStop)
    // The server's cancelled terminal brings everything the model wrote.
    rerender(stoppedAnswer(FINAL))
    act(() => vi.advanceTimersByTime(1500))
    expect(screen.getByTestId('prose').textContent).toBe(atStop)
    expect(screen.getByTestId('answer-stopped')).toHaveTextContent('Stopped')
    expect(screen.getByTestId('role-tab-pending')).toBeInTheDocument()
    expect(useAnswerRevealStore.getState().revealingId).toBeNull()
  })
})

// L27, L28: an answer that mounts in the middle of its turn (a reload's
// replay, a thread opened again) does not type out what had already arrived.
describe('an answer mounting mid-turn', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    })
  })
  afterEach(() => vi.useRealTimers())

  it('shows 2000 characters that had already arrived at once', () => {
    const arrived = STREAMED.repeat(Math.ceil(2000 / STREAMED.length))
    render(answer(arrived, true))
    expect(screen.getByTestId('prose').textContent).toBe(arrived)
    expect(screen.getByTestId('streaming-caret')).toBeInTheDocument()
  })
})

// The masthead's summary arrives whole, ahead of the prose. Faded in as one
// block it read as the answer's first words popping in finished while the
// sentence under it was being written: it is written in, then the prose.
describe('a summary that leads a fresh answer', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    })
  })
  afterEach(() => vi.useRealTimers())

  const SUMMARY =
    'Für ein konkretes Vorhaben ist zuerst der passende Teil nach Nutzung und Gebäudeart zu bestimmen; ob die Ausgabe im Bundesland gilt, ist gesondert zu prüfen.'
  const META = { v: 1 as const, kind: 'walkthrough' as const, summary: SUMMARY }
  const headed = (content: string, isStreaming: boolean) => (
    <AgentResponse
      content={content}
      isStreaming={isStreaming}
      messageId="m-sum"
      answerMeta={META}
      showAnswerFeedback={false}
    />
  )
  const standfirst = () => screen.queryByText((_, el) => el?.tagName === 'P' && el.closest('header') !== null)

  it('writes the summary in word by word, with the caret, before the prose begins', () => {
    const { rerender } = render(headed(STREAMED, true))
    const lengths: number[] = []
    let proseBeforeSummary = false
    for (let t = 0; t < 4000; t += FRAME_MS) {
      act(() => vi.advanceTimersByTime(FRAME_MS))
      const shown = standfirst()?.textContent ?? ''
      lengths.push(shown.length)
      if (shown.length < SUMMARY.length && (screen.getByTestId('prose').textContent ?? '') !== '') proseBeforeSummary = true
      // While the summary is being written, the caret is at its end.
      if (shown.length > 0 && shown.length < SUMMARY.length) {
        expect(standfirst()!.querySelector('[data-testid="streaming-caret"]')).not.toBeNull()
      }
    }
    // Written in steps, not one frame.
    expect(new Set(lengths.filter((n) => n > 0 && n < SUMMARY.length)).size).toBeGreaterThan(3)
    expect(proseBeforeSummary).toBe(false)
    expect(standfirst()!.textContent).toBe(SUMMARY)
    expect(screen.getByTestId('prose').textContent).toBe(STREAMED)
    rerender(headed(FINAL, false))
    act(() => vi.advanceTimersByTime(1500))
    expect(screen.getByTestId('prose').textContent).toBe(FINAL)
    expect(standfirst()!.textContent).toBe(SUMMARY)
  })

  it('draws a stored answer with its summary whole', () => {
    render(headed(FINAL, false))
    expect(standfirst()!.textContent).toBe(SUMMARY)
    expect(screen.getByTestId('prose').textContent).toBe(FINAL)
  })
})

// L12: a retraction keeps the answer's frame instead of dropping it.
describe('a retracted round', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    })
  })
  afterEach(() => vi.useRealTimers())

  const PREAMBLE = 'Ich sehe mir dazu die Richtlinie an und prüfe die Fluchtwege. '
  const ledeOn = () => screen.getByTestId('prose').parentElement!.className.includes('p:first-child')

  it('keeps the card, fades the words into one quiet line, and lets the next round decide its lede', async () => {
    const { rerender } = render(answer(PREAMBLE, true))
    act(() => vi.advanceTimersByTime(FRAME_MS * 30))
    expect(ledeOn()).toBe(true)

    rerender(answer('', true))
    // The frame stays, the withdrawn words still on it while they fade.
    expect(screen.getByRole('article')).toBeInTheDocument()
    expect(screen.getByTestId('prose').textContent).not.toBe('')
    expect(screen.queryByTestId('streaming-caret')).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByTestId('answer-retracting')).toHaveTextContent('Working on a response …')
    expect(screen.getByTestId('prose').textContent).toBe('')

    // The real answer opens with a heading: no lede carried over from the preamble.
    rerender(answer('## Fluchtwege\n\nIn Gebäudeklasse 4 gilt ', true))
    act(() => vi.advanceTimersByTime(FRAME_MS * 30))
    expect(screen.queryByTestId('answer-retracting')).toBeNull()
    expect(screen.getByTestId('prose').textContent).toContain('Fluchtwege')
    expect(ledeOn()).toBe(false)
  })
})
