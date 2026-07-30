import { describe, expect, it } from 'vitest'

import { errorConcernsTheThread } from './error-registry'


/**
 * Which errors belong to the CONVERSATION rather than to this browser (ADR-0037).
 *
 * This is what decides whether a colleague in a shared thread sees the failure. Get
 * it wrong in one direction and an observer watches a thread stop with no
 * explanation; wrong in the other and they are told their connection dropped when it
 * did not.
 */
describe('errorConcernsTheThread', () => {
  it('publishes a turn that genuinely failed', () => {
    for (const code of [
      'agent.response_failed',
      'agent.workflow_error',
      'agent.deep_research_failed',
      'agent.response_interrupted',
      'budget.exhausted',
      'research.queue_full',
      'system.unknown',
    ] as const) {
      expect(errorConcernsTheThread(code)).toBe(true)
    }
  })

  it('keeps this browser’s own session trouble to itself', () => {
    for (const code of [
      'connection.lost',
      'connection.failed',
      'connection.timeout',
      'auth.session_expired',
      'auth.unauthorized',
    ] as const) {
      expect(errorConcernsTheThread(code)).toBe(false)
    }
  })
})
