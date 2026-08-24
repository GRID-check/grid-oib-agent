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

const upThumb = () => screen.getByRole('button', { name: 'Mark this answer as helpful' })
const downThumb = () => screen.getByRole('button', { name: 'Mark this answer as not helpful' })

describe('AnswerFeedback', () => {
  describe('resting state', () => {
    test('is the question and two thumbs — nothing else', () => {
      render(<AnswerFeedback messageId="msg_1" />)

      expect(screen.getByText('Was this helpful?')).toBeInTheDocument()
      expect(upThumb()).toHaveAttribute('aria-pressed', 'false')
      expect(downThumb()).toHaveAttribute('aria-pressed', 'false')

      // No confirmation, no reasons, no note: the transaction has not started.
      expect(screen.queryByText('Rating saved.')).not.toBeInTheDocument()
      expect(screen.queryByText('What was the problem?')).not.toBeInTheDocument()
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    test('reserves the row height so a landing verdict cannot move the answer', () => {
      const { container } = render(<AnswerFeedback messageId="msg_1" />)

      expect(container.querySelector('.min-h-6')).not.toBeNull()
    })

    test('keeps a live region mounted so the confirmation is announced, not swapped in', () => {
      render(<AnswerFeedback messageId="msg_1" />)

      expect(screen.getByRole('status')).toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('')
    })
  })

  describe('up-vote path', () => {
    test('persists the vote and confirms it — with no form left open', async () => {
      const user = userEvent.setup()
      render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

      await user.click(upThumb())

      expect(upThumb()).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('status')).toHaveTextContent('Rating saved.')
      // The vote IS the transaction: nothing is left pending beside the thanks.
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      // The answered question steps aside for the answer.
      expect(screen.queryByText('Was this helpful?')).not.toBeInTheDocument()

      await waitFor(() => expect(postCalls()).toHaveLength(1))
      const [url, init] = postCalls()[0] as [string, RequestInit]
      expect(url).toBe('/api/feedback/answers')
      expect(JSON.parse(init.body as string)).toEqual({
        messageId: 'msg_1',
        verdict: 'up',
        reason: null,
        comment: null,
        conversationId: 'conv_1',
        projectId: 'proj_1',
      })
    })

    test('clicking the active thumb again retracts the vote (DELETE)', async () => {
      const user = userEvent.setup()
      render(<AnswerFeedback messageId="msg_1" />)

      await user.click(upThumb())
      await user.click(upThumb())

      expect(upThumb()).toHaveAttribute('aria-pressed', 'false')
      expect(screen.getByRole('status')).toHaveTextContent('')
      await waitFor(() => expect(deleteCalls()).toHaveLength(1))
      expect((deleteCalls()[0] as [string, RequestInit])[0]).toBe(
        '/api/feedback/answers?messageId=msg_1',
      )
    })

    test('the two thumbs are an exclusive choice, structurally', async () => {
      const user = userEvent.setup()
      render(<AnswerFeedback messageId="msg_1" />)

      await user.click(upThumb())
      await user.click(downThumb())

      expect(upThumb()).toHaveAttribute('aria-pressed', 'false')
      expect(downThumb()).toHaveAttribute('aria-pressed', 'true')
    })
  })

  describe('down-vote path', () => {
    test('discloses the reasons one step at a time, note last', async () => {
      const user = userEvent.setup()
      render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

      await user.click(downThumb())

      // Step 1: the vote is committed and said so.
      expect(screen.getByRole('status')).toHaveTextContent('Rating saved.')
      await waitFor(() => expect(postCalls()).toHaveLength(1))
      expect(JSON.parse((postCalls()[0] as [string, RequestInit])[1].body as string)).toMatchObject({
        verdict: 'down',
        reason: null,
      })

      // Step 2: the reasons, as an exclusive radiogroup.
      const group = screen.getByRole('radiogroup')
      expect(group).toHaveAccessibleName('What was the problem?')
      for (const label of ['Inaccurate', 'Too slow', 'Wrong source', 'Other']) {
        expect(screen.getByRole('radio', { name: label })).toBeInTheDocument()
      }
      // Step 3 has NOT happened yet: no note before a reason names the problem.
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

      await user.click(screen.getByRole('radio', { name: 'Wrong source' }))

      expect(screen.getByRole('radio', { name: 'Wrong source' })).toHaveAttribute('aria-checked', 'true')
      await waitFor(() => expect(postCalls()).toHaveLength(2))
      expect(JSON.parse((postCalls()[1] as [string, RequestInit])[1].body as string)).toMatchObject({
        verdict: 'down',
        reason: 'wrong_source',
        comment: null,
      })

      // Step 3: the optional note appears only now.
      expect(screen.getByRole('textbox')).toBeInTheDocument()
      expect(screen.getByLabelText('Anything else?')).toBeInTheDocument()
    })

    test('the reason chips are keyboard-operable as one radiogroup', async () => {
      const user = userEvent.setup()
      render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

      await user.click(downThumb())
      const first = screen.getByRole('radio', { name: 'Inaccurate' })
      first.focus()
      await user.keyboard('{ArrowRight}')

      expect(screen.getByRole('radio', { name: 'Too slow' })).toHaveFocus()
    })

    test('the submit is unambiguously disabled until the note has content', async () => {
      const user = userEvent.setup()
      render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

      await user.click(downThumb())
      await user.click(screen.getByRole('radio', { name: 'Inaccurate' }))

      const submit = screen.getByRole('button', { name: 'Send note' })
      expect(submit).toBeDisabled()

      await user.type(screen.getByRole('textbox'), '   ')
      expect(submit).toBeDisabled()

      await user.type(screen.getByRole('textbox'), 'Missed OIB RL 4.')
      expect(submit).toBeEnabled()
    })

    test('sends the note, then closes the second act', async () => {
      const user = userEvent.setup()
      render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

      await user.click(downThumb())
      await user.click(screen.getByRole('radio', { name: 'Inaccurate' }))
      await user.type(screen.getByPlaceholderText('Optional — tell us what went wrong'), 'Missed OIB RL 4.')
      await user.click(screen.getByRole('button', { name: 'Send note' }))

      await waitFor(() => expect(postCalls().length).toBeGreaterThanOrEqual(3))
      const lastBody = JSON.parse(
        (postCalls()[postCalls().length - 1] as [string, RequestInit])[1].body as string,
      )
      expect(lastBody).toMatchObject({
        verdict: 'down',
        reason: 'inaccurate',
        comment: 'Missed OIB RL 4.',
      })

      // The note is done; the vote and its reason stay on screen.
      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
      expect(screen.getByRole('radio', { name: 'Inaccurate' })).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByRole('status')).toHaveTextContent('Rating saved.')
    })

    test('retracting the down-vote takes the whole second act with it', async () => {
      const user = userEvent.setup()
      render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

      await user.click(downThumb())
      expect(screen.getByRole('radiogroup')).toBeInTheDocument()

      await user.click(downThumb())

      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('')
      expect(screen.getByText('Was this helpful?')).toBeInTheDocument()
    })
  })

  describe('colour', () => {
    test('carries no provenance or error chroma in any state', async () => {
      const user = userEvent.setup()
      const { container } = render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

      const forbidden = /(source-(law|oib|project|office|auto)|status-active|status-done|signal-error)/

      const assertClean = (label: string) => {
        for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
          expect(`${label}: ${el.className}`).not.toMatch(forbidden)
        }
      }

      assertClean('resting')

      await user.click(upThumb())
      assertClean('up')

      await user.click(downThumb())
      await user.click(screen.getByRole('radio', { name: 'Inaccurate' }))
      assertClean('down')

      // The selected thumb is still unmistakable: ink fill, not a tint.
      expect(downThumb().className).toMatch(/bg-foreground/)
    })
  })

  describe('persistence', () => {
    test('reverts the optimistic vote when the server rejects it', async () => {
      const user = userEvent.setup()
      mockFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
          : okJson({ feedback: [] }),
      )
      render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

      await user.click(upThumb())

      await waitFor(() => expect(upThumb()).toHaveAttribute('aria-pressed', 'false'))
      expect(screen.getByRole('status')).toHaveTextContent('')
    })

    test('hydrates an existing vote from the conversation GET', async () => {
      mockFetch.mockResolvedValue(
        okJson({ feedback: [{ messageId: 'msg_1', verdict: 'up', reason: null }] }),
      )
      render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

      await waitFor(() => expect(upThumb()).toHaveAttribute('aria-pressed', 'true'))
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/feedback/answers?conversationId=conv_1',
        expect.objectContaining({ credentials: 'same-origin' }),
      )
    })

    test('a hydrated note keeps the second act closed', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          feedback: [{ messageId: 'msg_1', verdict: 'down', reason: 'inaccurate', comment: 'Already said.' }],
        }),
      )
      render(<AnswerFeedback messageId="msg_1" conversationId="conv_1" />)

      await waitFor(() => expect(downThumb()).toHaveAttribute('aria-pressed', 'true'))
      expect(screen.getByRole('radio', { name: 'Inaccurate' })).toHaveAttribute('aria-checked', 'true')
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
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
})
