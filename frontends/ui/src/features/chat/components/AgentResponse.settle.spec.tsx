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
import { AgentResponse } from './AgentResponse'

vi.mock('../hooks/use-paced-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-paced-text')>()
  return {
    ...actual,
    usePacedText: (text: string, streaming: boolean) => actual.usePacedText(text, streaming, true),
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
vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span data-testid="prose">{content}</span>,
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

  it('ends the reveal when the answer goes away mid-stream', () => {
    const { unmount } = render(answer(STREAMED, true))
    expect(useAnswerRevealStore.getState().revealingId).toBe('m-1')
    unmount()
    expect(useAnswerRevealStore.getState().revealingId).toBeNull()
  })
})
