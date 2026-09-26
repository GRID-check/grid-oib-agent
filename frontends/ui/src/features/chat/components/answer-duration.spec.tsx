/**
 * How long the answer took, shown inside the answer details beside the time.
 *
 * Rendered for BOTH variants, because the prop is passed twice — the default
 * card the thread uses and the box-less inline rendering.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { en } from '@/i18n/dictionaries'
import { vi, describe, test, expect } from 'vitest'
import { AgentResponse } from './AgentResponse'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { ChatStoreWithHydration } from '../store'

vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: StoreSelector<ChatStoreWithHydration>) => {
    const state: DeepPartial<ChatStoreWithHydration> = {
      currentConversation: null,
      patchConversationMessage: vi.fn(),
    }
    return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
  }),
}))

vi.mock('@/adapters/api', () => ({ cancelJob: vi.fn() }))
vi.mock('@/adapters/auth', () => ({ useAuth: () => ({ accessToken: null }) }))
vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}))

const answeredIn = (duration: string) =>
  en.chat.answerDetails.duration.replace('{duration}', duration)

describe.each(['default', 'inline'] as const)('the %s answer variant', (variant) => {
  test('shows how long the answer took inside the details', async () => {
    render(
      <AgentResponse
        content="Zwei Fluchtwege."
        variant={variant}
        timestamp={new Date('2026-09-26T14:30:12')}
        answerDurationMs={12_400}
      />
    )
    expect(screen.queryByTestId('answer-time')).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByTestId('answer-details-trigger'))

    expect(screen.getByTestId('answer-time')).toHaveTextContent(answeredIn('12 sec'))
  })

  test('a duration alone is enough to open the details', async () => {
    render(<AgentResponse content="Zwei Fluchtwege." variant={variant} answerDurationMs={95_000} />)

    await userEvent.setup().click(screen.getByTestId('answer-details-trigger'))

    expect(screen.getByTestId('answer-time')).toHaveTextContent(answeredIn('2 min'))
  })

  test('says nothing about a duration it does not have', async () => {
    render(
      <AgentResponse
        content="Zwei Fluchtwege."
        variant={variant}
        timestamp={new Date('2026-09-26T14:30:12')}
      />
    )
    await userEvent.setup().click(screen.getByTestId('answer-details-trigger'))

    expect(screen.getByTestId('answer-time')).not.toHaveTextContent(answeredIn(''))
  })
})
