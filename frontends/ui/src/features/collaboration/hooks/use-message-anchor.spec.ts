/**
 * The message half of an inbox deep link.
 *
 * What these pin is the timing, because the timing is the whole reason the hook
 * exists: the hash is present before the thread is fetched, so a naive
 * "scroll on mount" resolves to nothing and the recipient is dropped at the
 * bottom of a thread with no idea which message concerns them.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { messageIdFromHash, useMessageAnchor } from './use-message-anchor'

const setHash = (hash: string) => {
  window.history.replaceState(null, '', `/app/projects/p1/chat?session=s1${hash}`)
}

/** jsdom has no layout, so scrollIntoView is absent on the prototype. */
const scrollIntoView = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/app/projects/p1/chat?session=s1')
  Element.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

const mountMessage = (id: string) => {
  const el = document.createElement('div')
  el.id = `message-${id}`
  document.body.appendChild(el)
}

describe('messageIdFromHash', () => {
  test('reads the message id', () => {
    expect(messageIdFromHash('#message-msg_7')).toBe('msg_7')
  })

  test('decodes it, so an id needing escaping still resolves', () => {
    expect(messageIdFromHash('#message-msg%2F7')).toBe('msg/7')
  })

  test('ignores every other hash, and no hash at all', () => {
    expect(messageIdFromHash('#report')).toBeNull()
    expect(messageIdFromHash('')).toBeNull()
    expect(messageIdFromHash(null)).toBeNull()
    // A prefix with nothing after it is not a target.
    expect(messageIdFromHash('#message-')).toBeNull()
  })
})

describe('useMessageAnchor', () => {
  test('does nothing without a message hash', () => {
    mountMessage('msg_7')

    const { result } = renderHook(() => useMessageAnchor(['msg_7']))

    expect(result.current).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  test('waits for the message to arrive, then scrolls to it and marks it', () => {
    setHash('#message-msg_7')

    // First render: the thread has not loaded. This is the case that was broken —
    // a plain browser hash resolves to nothing here and is then gone.
    const { result, rerender } = renderHook(({ ids }) => useMessageAnchor(ids), {
      initialProps: { ids: [] as string[] },
    })
    expect(result.current).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()

    // The thread lands.
    mountMessage('msg_7')
    rerender({ ids: ['msg_7'] })

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(result.current).toBe('msg_7')
  })

  test('holds the target while the id is known but not yet painted', () => {
    setHash('#message-msg_7')

    const { result, rerender } = renderHook(({ ids }) => useMessageAnchor(ids), {
      initialProps: { ids: ['msg_7'] },
    })

    // Id present, node absent — must NOT consume the target.
    expect(result.current).toBeNull()

    mountMessage('msg_7')
    rerender({ ids: ['msg_7', 'msg_8'] })

    expect(result.current).toBe('msg_7')
  })

  test('the mark fades on its own', () => {
    setHash('#message-msg_7')
    mountMessage('msg_7')

    const { result } = renderHook(() => useMessageAnchor(['msg_7']))
    expect(result.current).toBe('msg_7')

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(result.current).toBeNull()
  })

  test('consumes the hash, so a reload leaves the reader where they are', () => {
    setHash('#message-msg_7')
    mountMessage('msg_7')

    renderHook(() => useMessageAnchor(['msg_7']))

    expect(window.location.hash).toBe('')
    // …and the session parameter survives: the hash is dropped, not the URL.
    expect(window.location.search).toBe('?session=s1')
  })

  test('a message that is never in the thread is simply ignored', () => {
    setHash('#message-msg_missing')
    mountMessage('msg_7')

    const { result } = renderHook(() => useMessageAnchor(['msg_7']))

    expect(result.current).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
    // The hash is left alone — nothing was consumed, so nothing is rewritten.
    expect(window.location.hash).toBe('#message-msg_missing')
  })
})
