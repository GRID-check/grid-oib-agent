/**
 * The shell's notification offer: the inbox prompt's offer, made once as a
 * toast when something first waits on a person who may never open the inbox.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, render, waitFor } from '@/test-utils'

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const badge = vi.hoisted(() => ({ pending: 0 }))
vi.mock('@/features/collaboration/hooks/use-inbox', () => ({
  useInboxBadge: () => ({ pending: badge.pending, connected: true, refresh: () => undefined }),
}))

const push = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }))
vi.mock('../hooks/use-push-notifications', () => ({ usePushNotifications: () => push.current }))

import type { InboxClient } from '@/lib/inbox/client'
import type { InboxItemView } from '@/lib/inbox/types'
import { pushFixture } from './fixtures'
import { InboxPushOffer } from './inbox-push-offer'
import { NotificationPrompt } from './notification-prompt'

function client(newest: Partial<InboxItemView> | null): InboxClient {
  return {
    list: vi.fn(async () => ({
      items: newest ? [newest as InboxItemView] : [],
      pending: 1,
      counts: { requests: 1, unread: 1 },
      hasMore: false,
      nextCursor: null,
    })),
  } as Partial<InboxClient> as InboxClient
}

const enable = vi.fn(async () => undefined)

beforeEach(() => {
  toastMock.mockClear()
  toastMock.dismiss.mockClear()
  enable.mockClear()
  badge.pending = 0
  push.current = pushFixture({ enable }) as unknown as Record<string, unknown>
  window.localStorage.clear()
  window.sessionStorage.clear()
})
afterEach(() => vi.restoreAllMocks())

describe('InboxPushOffer', () => {
  test('when something first waits, offers notifications once, naming who mentioned the person', async () => {
    const inbox = client({ actorName: 'Anna Weber', type: 'mention.requested' })
    const view = render(<InboxPushOffer enabled client={inbox} />)
    expect(toastMock).not.toHaveBeenCalled()

    badge.pending = 2
    view.rerender(<InboxPushOffer enabled client={inbox} />)
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1))
    // Named from the requests waiting on the person, never from an FYI.
    expect(inbox.list).toHaveBeenCalledWith({ filter: 'requests' })
    const [message, options] = toastMock.mock.calls[0] as [string, { action: { label: string; onClick: () => void }; cancel: { label: string } }]
    expect(message).toBe('Anna Weber mentioned you. Do you want to be notified on this device?')
    expect(options.action.label).toBe('Turn on')
    expect(options.cancel.label).toBe('Not now')

    act(() => options.action.onClick())
    expect(enable).toHaveBeenCalledTimes(1)

    // Once: a later step from nothing to something does not ask again.
    badge.pending = 0
    view.rerender(<InboxPushOffer enabled client={inbox} />)
    badge.pending = 1
    view.rerender(<InboxPushOffer enabled client={inbox} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toastMock).toHaveBeenCalledTimes(1)
  })

  test('without a person to name, says someone needs them', async () => {
    badge.pending = 1
    render(<InboxPushOffer enabled client={client({ actorName: null, type: 'piloti.asks_you' })} />)
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('Someone needs you in Piloti. Do you want to be notified on this device?', expect.anything())
    )
  })

  test('„Not now“ is the inbox prompt’s own dismissal', async () => {
    badge.pending = 1
    render(<InboxPushOffer enabled client={client({ actorName: 'Anna Weber', type: 'annotation.assigned_to_you' })} />)
    await waitFor(() => expect(toastMock).toHaveBeenCalled())
    const [message, options] = toastMock.mock.calls[0] as [string, { cancel: { onClick: () => void } }]
    expect(message).toBe('Anna Weber needs you in Piloti. Do you want to be notified on this device?')
    act(() => options.cancel.onClick())
    expect(window.localStorage.getItem('piloti.push-prompt.dismissed')).toBe('1')
  })

  test('stands down while the inbox shows its own card, and takes a toast already up away', async () => {
    badge.pending = 1
    const view = render(
      <>
        <NotificationPrompt />
        <InboxPushOffer enabled client={client({ actorName: 'Anna Weber', type: 'mention.requested' })} />
      </>
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toastMock).not.toHaveBeenCalled()
    expect(toastMock.dismiss).toHaveBeenCalledWith('piloti-push-offer')
    view.unmount()
  })

  test('is not made when the prompt is not due: dismissed, already on, or a browser that cannot', async () => {
    window.localStorage.setItem('piloti.push-prompt.dismissed', '1')
    badge.pending = 1
    const view = render(<InboxPushOffer enabled client={client(null)} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.unmount()

    window.localStorage.clear()
    push.current = pushFixture({ thisDeviceOn: true }) as unknown as Record<string, unknown>
    render(<InboxPushOffer enabled client={client(null)} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toastMock).not.toHaveBeenCalled()
  })
})
