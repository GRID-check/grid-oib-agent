import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AnswerFeedback } from './AnswerFeedback'
import { __clearAnswerFeedbackCache } from '../hooks/use-answer-feedback'

// Mock the chat store (projectId for the persistence payload).
vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: (s: { projectId: string | null }) => unknown) => {
    const state = { projectId: 'proj_1' }
    return selector ? selector(state) : state
  }),
}))

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response

const mockFetch = vi.fn()

beforeEach(() => {
  __clearAnswerFeedbackCache()
  mockFetch.mockReset()
  // Default: hydration finds nothing, writes succeed.
  mockFetch.mockResolvedValue(okJson({ feedback: [] }))
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const postCalls = () =>
  mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
const deleteCalls = () =>
  mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')

describe('AnswerFeedback', () => {
  test('renders the quiet thumbs row', () => {
    render(<AnswerFeedback messageId="msg_1" />)

    expect(screen.getByText('Was this helpful?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark this answer as helpful' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark this answer as not helpful' })).toBeInTheDocument()
  })

  test('thumbs up persists an up vote and shows the thanks line', async () => {
    const user = userEvent.setup()
    render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

    await user.click(screen.getByRole('button', { name: 'Mark this answer as helpful' }))

    expect(screen.getByRole('button', { name: 'Mark this answer as helpful' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText('Thanks for your feedback.')).toBeInTheDocument()

    await waitFor(() => expect(postCalls()).toHaveLength(1))
    const [url, init] = postCalls()[0] as [string, RequestInit]
    expect(url).toBe('/api/feedback/answers')
    expect(JSON.parse(init.body as string)).toEqual({
      messageId: 'msg_1',
      verdict: 'up',
      reason: null,
      conversationId: 'conv_1',
      projectId: 'proj_1',
    })
  })

  test('clicking the active thumb again retracts the vote (DELETE)', async () => {
    const user = userEvent.setup()
    render(<AnswerFeedback messageId="msg_1" />)

    const upButton = screen.getByRole('button', { name: 'Mark this answer as helpful' })
    await user.click(upButton)
    await user.click(upButton)

    expect(upButton).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('Thanks for your feedback.')).not.toBeInTheDocument()
    await waitFor(() => expect(deleteCalls()).toHaveLength(1))
    expect((deleteCalls()[0] as [string, RequestInit])[0]).toBe(
      '/api/feedback/answers?messageId=msg_1',
    )
  })

  test('thumbs down opens the reason chips; picking one persists it and thanks', async () => {
    const user = userEvent.setup()
    render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

    await user.click(screen.getByRole('button', { name: 'Mark this answer as not helpful' }))

    expect(screen.getByText('What was the problem?')).toBeInTheDocument()
    for (const label of ['Inaccurate', 'Too slow', 'Wrong source', 'Other']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.queryByText('Thanks for your feedback.')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Wrong source' }))

    expect(screen.queryByText('What was the problem?')).not.toBeInTheDocument()
    expect(screen.getByText('Thanks for your feedback.')).toBeInTheDocument()

    await waitFor(() => expect(postCalls()).toHaveLength(2))
    const lastBody = JSON.parse((postCalls()[1] as [string, RequestInit])[1].body as string)
    expect(lastBody).toMatchObject({ verdict: 'down', reason: 'wrong_source' })
  })

  test('reverts the optimistic vote when the server rejects it', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
        : okJson({ feedback: [] }),
    )
    render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

    const upButton = screen.getByRole('button', { name: 'Mark this answer as helpful' })
    await user.click(upButton)

    await waitFor(() => expect(upButton).toHaveAttribute('aria-pressed', 'false'))
    expect(screen.queryByText('Thanks for your feedback.')).not.toBeInTheDocument()
  })

  test('hydrates an existing vote from the conversation GET', async () => {
    mockFetch.mockResolvedValue(
      okJson({ feedback: [{ messageId: 'msg_1', verdict: 'up', reason: null }] }),
    )
    render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark this answer as helpful' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/feedback/answers?conversationId=conv_1',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  test('fetches hydration once per conversation across multiple answers', async () => {
    render(
      <>
        <AnswerFeedback messageId="msg_1" conversationId="conv_1" />
        <AnswerFeedback messageId="msg_2" conversationId="conv_1" />
      </>,
    )

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    const gets = mockFetch.mock.calls.filter(([url]) => String(url).includes('conversationId='))
    expect(gets).toHaveLength(1)
  })
})
