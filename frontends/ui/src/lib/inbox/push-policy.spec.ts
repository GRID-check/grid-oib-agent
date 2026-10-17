/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { INBOX_ITEM_TYPES } from '@/lib/db/schema'
import {
  applyPushPreferencesPatch,
  DEFAULT_PUSH_PREFERENCES,
  PUSH_CATEGORIES,
  PUSH_CATEGORY_DEFAULTS,
  resolvePushPreferences,
} from './push-categories'
import { isPushStillDue, isPushWanted, pushCategoryOf, pushPolicyFor, PUSH_TTL_SECONDS } from './push-policy'

const unread = { readAt: null, archivedAt: null, resolvedAt: null, inertAt: null }

describe('the registry names a push policy for every type', () => {
  it.each(INBOX_ITEM_TYPES)('%s has a known category and urgency', (type) => {
    const policy = pushPolicyFor(type)
    expect(policy).not.toBeNull()
    expect(PUSH_CATEGORIES).toContain(policy?.category)
    expect(Object.keys(PUSH_TTL_SECONDS)).toContain(policy?.urgency)
  })

  it('treats a type this build does not know as never pushed', () => {
    expect(pushPolicyFor('from.the.future')).toBeNull()
    expect(isPushWanted('from.the.future', DEFAULT_PUSH_PREFERENCES)).toBe(false)
    expect(isPushStillDue({ ...unread, type: 'from.the.future' as never })).toBe(false)
  })

  it('is on by default for what is addressed to the person and off for ambient activity', () => {
    for (const type of ['mention.requested', 'piloti.asks_you', 'job.waiting', 'document.review_requested'] as const) {
      expect(isPushWanted(type, DEFAULT_PUSH_PREFERENCES)).toBe(true)
    }
    for (const type of ['conversation.activity', 'upload.completed', 'document.new_fassung'] as const) {
      expect(isPushWanted(type, DEFAULT_PUSH_PREFERENCES)).toBe(false)
    }
  })

  it('wakes a device sooner for a request than for an FYI', () => {
    expect(pushPolicyFor('mention.requested')?.urgency).toBe('high')
    expect(pushPolicyFor('conversation.activity')?.urgency).toBe('low')
    expect(PUSH_TTL_SECONDS.high).toBeGreaterThan(PUSH_TTL_SECONDS.low)
  })
})

describe('a person’s choices override the default per category', () => {
  it('turning a category on or off decides every type in it', () => {
    const on = applyPushPreferencesPatch(DEFAULT_PUSH_PREFERENCES, { categories: { activity: true } })
    expect(isPushWanted('conversation.activity', on)).toBe(true)
    const off = applyPushPreferencesPatch(DEFAULT_PUSH_PREFERENCES, { categories: { requests: false } })
    expect(isPushWanted('mention.requested', off)).toBe(false)
    expect(isPushWanted('piloti.intake_ready', off)).toBe(false)
    expect(isPushWanted('mention.answered', off)).toBe(true)
  })

  it('news on a mark the person wrote is an answer to them, pushed with results; on anyone else’s it is activity', () => {
    expect(pushCategoryOf('annotation.activity', { yours: true })).toBe('results')
    expect(pushCategoryOf('annotation.activity', {})).toBe('activity')
    expect(pushCategoryOf('annotation.activity', { yours: 'true' })).toBe('activity')
    // Off by default for activity, on for results: the author hears, the thread does not.
    expect(isPushWanted('annotation.activity', DEFAULT_PUSH_PREFERENCES, { yours: true })).toBe(true)
    expect(isPushWanted('annotation.activity', DEFAULT_PUSH_PREFERENCES, { variant: 'reply' })).toBe(false)
    // A type without a `yours` category keeps its own.
    expect(pushCategoryOf('conversation.activity', { yours: true })).toBe('activity')
  })

  it('reads a damaged stored bag as the defaults, never as an opt-in', () => {
    expect(resolvePushPreferences(undefined)).toEqual(DEFAULT_PUSH_PREFERENCES)
    expect(resolvePushPreferences('yes')).toEqual(DEFAULT_PUSH_PREFERENCES)
    const damaged = resolvePushPreferences({ showContent: 'no', categories: { activity: 'true', requests: false, nope: true } })
    expect(damaged.showContent).toBe(true)
    expect(damaged.categories).toEqual({ ...PUSH_CATEGORY_DEFAULTS, requests: false })
  })
})

describe('an item stops being news when the person dealt with it', () => {
  it('is due while unread', () => {
    expect(isPushStillDue({ ...unread, type: 'mention.requested' })).toBe(true)
  })

  it.each(['readAt', 'archivedAt', 'resolvedAt', 'inertAt'] as const)('is not due once %s is set', (field) => {
    expect(isPushStillDue({ ...unread, type: 'mention.requested', [field]: new Date() })).toBe(false)
  })
})
