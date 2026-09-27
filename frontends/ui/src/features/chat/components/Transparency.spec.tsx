/**
 * Rendering tests for the WP-B transparency extras: the escalation narration in
 * the Herleitung, the mid-turn drop notice, and the queue-rejection
 * (research.queue_full) banner. These assert the real i18n
 * copy (English, the default test locale) and the real error registry.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, test, expect } from 'vitest'
import { ChatThinking } from './ChatThinking'
import { ErrorBanner } from './ErrorBanner'
import { storedStep } from '@/test-utils/wire-v2-steps'

const createStep = () => storedStep({ id: 'tool:1', kind: 'tool', tool: 'knowledge_search', status: 'ok' })

describe('ChatThinking escalation narration', () => {
  test('shows the escalation narration in the framing node when escalated', async () => {
    const user = userEvent.setup()
    render(
      <ChatThinking
        steps={[createStep()]}
        isThinking={false}
        userQuestion="Frage"
        escalationReason="Die erste Antwort war unzureichend."
      />
    )

    await user.click(screen.getByText(/^Trace( ·|$)/))
    expect(
      screen.getByText('Escalated to deep research: Die erste Antwort war unzureichend.')
    ).toBeInTheDocument()
  })
})

describe('ChatThinking mid-turn drop notice', () => {
  test('shows the compact resend notice on an interrupted turn', () => {
    render(<ChatThinking steps={[createStep()]} isThinking={false} isInterrupted />)

    expect(
      screen.getByText('Connection briefly lost — the answer was dropped. Please resend.')
    ).toBeInTheDocument()
  })

  test('does not show the notice on a completed (non-interrupted) turn', () => {
    render(<ChatThinking steps={[createStep()]} isThinking={false} />)

    expect(
      screen.queryByText('Connection briefly lost — the answer was dropped. Please resend.')
    ).not.toBeInTheDocument()
  })
})

describe('research.queue_full rejection banner', () => {
  test('renders the queue-full warning banner via the real error registry', () => {
    render(
      <ErrorBanner
        code="research.queue_full"
        message="The research queue is currently full. Please resend your request in a moment. Please try again in about 30 seconds."
      />
    )

    // Localized title from the registry (research.queue_full → titleKey).
    expect(screen.getByText('Research is busy')).toBeInTheDocument()
    // The caller-composed message including the retry hint.
    expect(screen.getByText(/Please try again in about 30 seconds\./)).toBeInTheDocument()
    // It is an alert (banner), not a silent notice.
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
