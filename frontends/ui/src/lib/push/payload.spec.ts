/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { DEFAULT_PUSH_PREFERENCES } from '@/lib/inbox/push-categories'
import type { InboxItemView } from '@/lib/inbox/types'
import { buildPushMessage, isSameOriginPath, pushTagFor } from './payload'

function item(overrides: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id: 'item-1',
    type: 'mention.requested',
    state: 'unread',
    archived: false,
    actionable: true,
    resourceType: 'conversation',
    resourceId: 'c1',
    anchorId: 'm-9',
    actorName: 'Anna Weber',
    actorUserId: 'u-anna',
    count: 1,
    href: '/app/projects/p1/chat?session=c1#m-9',
    subject: 'Atrium – Rauchabschnitte GK 4',
    related: null,
    excerpt: 'Ist die Brandwand hier nach EN 1366 geprüft? (vertraulicher Auszug)',
    variant: null,
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
    ...overrides,
  }
}

describe('what a notification says', () => {
  it('words the item as the inbox row does, in the recipient’s language, with its address', () => {
    const message = buildPushMessage(item(), 'mention.requested:conversation:c1:m-9', DEFAULT_PUSH_PREFERENCES, 'de')
    expect(message).toMatchObject({
      version: 1,
      title: 'Anna Weber hat um Ihre Einschätzung gebeten',
      body: 'in Atrium – Rauchabschnitte GK 4',
      url: '/app/projects/p1/chat?session=c1#m-9',
      itemId: 'item-1',
    })
    const english = buildPushMessage(item(), 'k', DEFAULT_PUSH_PREFERENCES, 'en')
    expect(english?.title).not.toBe(message?.title)
  })

  it('never carries the excerpt, which the inbox may later withhold', () => {
    const message = buildPushMessage(item(), 'k', DEFAULT_PUSH_PREFERENCES, 'de')
    expect(JSON.stringify(message)).not.toContain('Brandwand')
  })

  it('carries only a generic line when the lock-screen preview is off', () => {
    const message = buildPushMessage(item(), 'k', { ...DEFAULT_PUSH_PREFERENCES, showContent: false }, 'de')
    expect(message?.title).toBe('Neue Nachricht in Piloti')
    expect(message?.body).toBeNull()
    const text = JSON.stringify(message)
    expect(text).not.toContain('Anna')
    expect(text).not.toContain('Atrium')
  })

  it('sends nothing for an item with no address, or one that leaves the origin', () => {
    expect(buildPushMessage(item({ href: null }), 'k', DEFAULT_PUSH_PREFERENCES, 'de')).toBeNull()
    expect(buildPushMessage(item({ href: 'https://evil.example/x' }), 'k', DEFAULT_PUSH_PREFERENCES, 'de')).toBeNull()
    expect(buildPushMessage(item({ href: '//evil.example/x' }), 'k', DEFAULT_PUSH_PREFERENCES, 'de')).toBeNull()
  })

  it('keeps one line short enough for a lock screen', () => {
    const message = buildPushMessage(item({ subject: 'x'.repeat(400) }), 'k', DEFAULT_PUSH_PREFERENCES, 'de')
    expect((message?.body ?? '').length).toBeLessThanOrEqual(140)
  })
})

describe('the tag and Topic of a group', () => {
  it('is the same for the same group and a valid Topic (32 URL-safe characters)', () => {
    const tag = pushTagFor('conversation.activity:conversation:c1')
    expect(tag).toBe(pushTagFor('conversation.activity:conversation:c1'))
    expect(tag).not.toBe(pushTagFor('conversation.activity:conversation:c2'))
    expect(tag).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('does not reveal the group key', () => {
    expect(pushTagFor('conversation.activity:conversation:secret-id')).not.toContain('secret')
  })
})

describe('same-origin paths', () => {
  it.each([
    ['/app/inbox', true],
    ['//evil.example', false],
    ['https://x.example', false],
    ['/\\evil.example', false],
    ['app/inbox', false],
  ])('%s -> %s', (value, expected) => {
    expect(isSameOriginPath(value)).toBe(expected)
  })
})
