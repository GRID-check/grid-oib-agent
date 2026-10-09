import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RetryThoroughButton } from './RetryThoroughButton'
import { __clearAnswerFeedbackCache } from '../hooks/use-answer-feedback'
import { useEffortStore } from '../stores/effort-store'

const send = vi.fn()
const capture = vi.fn()

vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: (...args: unknown[]) => capture(...args) }))
vi.mock('../hooks/use-current-session-busy', () => ({ useIsCurrentSessionBusy: () => false }))
/** The answer's recorded Aufwand; `undefined` is an answer stored before it was recorded. */
let answerRanAt: string | undefined
vi.mock('../store', () => ({
  useChatStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      projectId: 'proj_1',
      chatSendFn: send,
      currentConversation: {
        id: 'conv_1',
        messages: [
          { id: 'u1', role: 'user', messageType: 'user', content: 'Wie breit muss die Treppe sein?' },
          {
            id: 'a1',
            role: 'assistant',
            messageType: 'assistant',
            content: 'Mindestens 1,20 m.',
            reasoningEffort: answerRanAt,
          },
        ],
      },
    }),
  ),
}))

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response

const mockFetch = vi.fn()

const hydrate = (verdict: 'up' | 'down' | null) =>
  mockFetch.mockResolvedValue(
    okJson({ feedback: verdict ? [{ messageId: 'a1', verdict, reason: null, comment: null }] : [] }),
  )

const retryName = /same question again/i

beforeEach(() => {
  __clearAnswerFeedbackCache()
  send.mockReset()
  capture.mockReset()
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
  useEffortStore.setState({ orgDefault: 'medium', draft: null, byConversation: {} })
  answerRanAt = undefined
})
afterEach(() => vi.unstubAllGlobals())

describe('RetryThoroughButton', () => {
  test('renders only after a down-vote', async () => {
    hydrate('up')
    const { unmount } = render(<RetryThoroughButton messageId="a1" conversationId="conv_1" />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: retryName })).toBeNull()
    unmount()

    __clearAnswerFeedbackCache()
    hydrate('down')
    render(<RetryThoroughButton messageId="a1" conversationId="conv_1" />)
    expect(await screen.findByRole('button', { name: retryName })).toBeInTheDocument()
  })

  test('fades in when it appears under an answer already on screen', async () => {
    hydrate('down')
    render(<RetryThoroughButton messageId="a1" conversationId="conv_1" />)
    const button = await screen.findByRole('button', { name: retryName })
    expect(button.className).toMatch(/fade-in-0/)
    expect(button.className).toMatch(/motion-reduce:animate-none/)
  })

  test('re-asks the original question at high without touching the effort store', async () => {
    hydrate('down')
    render(<RetryThoroughButton messageId="a1" conversationId="conv_1" />)
    await userEvent.click(await screen.findByRole('button', { name: retryName }))

    expect(send).toHaveBeenCalledWith('Wie breit muss die Treppe sein?', { reasoningEffort: 'high' })
    expect(useEffortStore.getState().byConversation).toEqual({})
    expect(useEffortStore.getState().draft).toBeNull()
    expect(capture).toHaveBeenCalledWith('answer_retry_thorough', {
      message_id: 'a1',
      original_effort: 'medium',
    })
  })

  test('steps high up to xhigh and hides at xhigh', async () => {
    useEffortStore.setState({ byConversation: { conv_1: 'high' } })
    hydrate('down')
    const { unmount } = render(<RetryThoroughButton messageId="a1" conversationId="conv_1" />)
    await userEvent.click(await screen.findByRole('button', { name: retryName }))
    expect(send).toHaveBeenCalledWith(expect.any(String), { reasoningEffort: 'xhigh' })
    unmount()

    __clearAnswerFeedbackCache()
    useEffortStore.setState({ byConversation: { conv_1: 'xhigh' } })
    render(<RetryThoroughButton messageId="a1" conversationId="conv_1" />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: retryName })).toBeNull()
  })

  test('steps up from the level the answer ran at, not from where the dial moved since', async () => {
    // Asked at medium, then the reader turned the dial to high: the retry is
    // one step above the answer (high), not above the dial (xhigh).
    answerRanAt = 'medium'
    useEffortStore.setState({ byConversation: { conv_1: 'high' } })
    hydrate('down')
    const { unmount } = render(<RetryThoroughButton messageId="a1" conversationId="conv_1" />)
    await userEvent.click(await screen.findByRole('button', { name: retryName }))
    expect(send).toHaveBeenCalledWith(expect.any(String), { reasoningEffort: 'high' })
    expect(capture).toHaveBeenCalledWith('answer_retry_thorough', { message_id: 'a1', original_effort: 'medium' })
    unmount()

    // Asked at xhigh, dial turned down since: still nothing thorougher to offer.
    __clearAnswerFeedbackCache()
    answerRanAt = 'xhigh'
    useEffortStore.setState({ byConversation: { conv_1: 'minimal' } })
    render(<RetryThoroughButton messageId="a1" conversationId="conv_1" />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: retryName })).toBeNull()
  })

  test('falls back to the dial for an answer with no recorded level', async () => {
    useEffortStore.setState({ byConversation: { conv_1: 'high' } })
    hydrate('down')
    render(<RetryThoroughButton messageId="a1" conversationId="conv_1" />)
    await userEvent.click(await screen.findByRole('button', { name: retryName }))
    expect(send).toHaveBeenCalledWith(expect.any(String), { reasoningEffort: 'xhigh' })
  })
})
