import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@/test-utils'

import { AnswerCost } from './AnswerCost'

function answerUsage(usage: Record<string, unknown> | null) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ usage }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const BILLED = {
  unit: 'credit',
  credits: 3.46,
  promptTokens: 21000,
  completionTokens: 1800,
  reasoningTokens: 1200,
  totalTokens: 22800,
}

describe('AnswerCost', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the credits the answer was billed, with the token split on hover', async () => {
    const fetchMock = answerUsage(BILLED)
    render(<AnswerCost conversationId="c1" messageId="m1" />)

    const line = await screen.findByTestId('answer-cost')
    expect(line).toHaveTextContent('3.5 credits')
    expect(line.getAttribute('title')).toMatch(/21,000.*1,800.*1,200/)
    expect(fetchMock).toHaveBeenCalledWith('/api/conversations/c1/messages/m1/usage', expect.anything())
  })

  it("counts tokens on the organization's own key, where nothing is billed", async () => {
    answerUsage({ ...BILLED, unit: 'token', credits: 0 })
    render(<AnswerCost conversationId="c1" messageId="m1" />)

    expect(await screen.findByTestId('answer-cost')).toHaveTextContent('22,800 tokens')
  })

  it('shows nothing for an answer no ledger row names', async () => {
    const fetchMock = answerUsage(null)
    render(<AnswerCost conversationId="c1" messageId="m1" />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByTestId('answer-cost')).toBeNull()
  })
})
