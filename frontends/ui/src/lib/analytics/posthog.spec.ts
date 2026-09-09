import { describe, expect, test } from 'vitest'
import {
  DISABLED_POSTHOG_CONFIG,
  capturePosthog,
  identifyPosthog,
  initPosthogClient,
  isPosthogEnabled,
  resetPosthog,
} from './posthog'

/**
 * Fail-open contract: without a configured host/token the client never
 * initializes and every emit is a silent no-op. Analytics must never take
 * the app down with it — this is the ratchet for the dev-time throw the
 * PostHog wizard originally shipped.
 */
describe('posthog analytics facade', () => {
  test('stays disabled when initialized without configuration', () => {
    initPosthogClient('', '')
    expect(isPosthogEnabled()).toBe(false)
  })

  test('capture/identify/reset are silent no-ops while disabled', () => {
    expect(() => {
      capturePosthog('project_created')
      capturePosthog('skill_enabled_changed', { scope: 'curated', enabled: true })
      identifyPosthog('user-1', { email: 'a@example.test' })
      resetPosthog()
    }).not.toThrow()
    expect(isPosthogEnabled()).toBe(false)
  })

  test('disabled config carries no host or token', () => {
    expect(DISABLED_POSTHOG_CONFIG).toEqual({ host: '', projectToken: '' })
  })
})
