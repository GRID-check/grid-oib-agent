import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { SubmitProductFeedbackRequest, SubmitProductFeedbackResult } from '@/lib/product-feedback/client'
import { FeedbackDialog } from './feedback-dialog'

const ok: SubmitProductFeedbackResult = {
  ok: true,
  report: { id: 'r1', kind: 'bug', createdAt: '2026-09-29T08:00:00Z' },
}

function setup(result: SubmitProductFeedbackResult = ok) {
  const submit = vi.fn<(request: SubmitProductFeedbackRequest) => Promise<SubmitProductFeedbackResult>>()
  submit.mockResolvedValue(result)
  const onOpenChange = vi.fn()
  render(
    <FeedbackDialog open onOpenChange={onOpenChange} submit={submit} userEmail="maria@buero.test" />,
  )
  return { submit, onOpenChange, user: userEvent.setup() }
}

const message = () => screen.getByTestId('feedback-message')
const send = () => screen.getByTestId('feedback-send')

describe('FeedbackDialog', () => {
  test('sends the kind, the trimmed message, the contact choice and the captured page', async () => {
    const { submit, user } = setup()

    await user.click(screen.getByRole('radio', { name: /Idea/ }))
    await user.type(message(), '  Please add an export for plan lists.  ')
    await user.click(screen.getByRole('checkbox', { name: 'You may contact me about this' }))
    await user.click(send())

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const request = submit.mock.calls[0]![0]
    expect(request).toMatchObject({
      kind: 'idea',
      message: 'Please add an export for plan lists.',
      allowContact: false,
      pagePath: '/',
    })
    expect(request.context.viewport).toMatch(/\d+×\d+/)
  })

  test('opens on a bug, the kind most people come to report', () => {
    setup()
    expect(screen.getByRole('radio', { name: /Bug/ })).toHaveAttribute('aria-checked', 'true')
  })

  test('refuses a message too short to act on, without sending', async () => {
    const { submit, user } = setup()

    await user.type(message(), 'Bug')
    await user.click(send())

    expect(await screen.findByRole('alert')).toHaveTextContent('at least 10 characters')
    expect(submit).not.toHaveBeenCalled()
  })

  test('sends on ⌘/Ctrl + Enter', async () => {
    const { submit, user } = setup()

    await user.type(message(), 'The upload stops at 99 percent.')
    await user.keyboard('{Control>}{Enter}{/Control}')

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  })

  test('thanks the reporter once it is sent', async () => {
    const { user } = setup()

    await user.type(message(), 'The upload stops at 99 percent.')
    await user.click(send())

    expect(await screen.findByTestId('feedback-sent')).toHaveTextContent('Thank you!')
  })

  test('keeps the text and explains when sending fails', async () => {
    const { user } = setup({ ok: false, reason: 'rate-limited' })

    await user.type(message(), 'The upload stops at 99 percent.')
    await user.click(send())

    expect(await screen.findByRole('alert')).toHaveTextContent('a lot of feedback in the last hour')
    expect(message()).toHaveValue('The upload stops at 99 percent.')
  })

  test('says where a reply would go', () => {
    setup()
    expect(screen.getByText(/maria@buero\.test/)).toBeInTheDocument()
  })
})
