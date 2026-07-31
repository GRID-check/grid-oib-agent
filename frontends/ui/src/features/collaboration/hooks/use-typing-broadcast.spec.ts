/**
 * The throttle is the feature.
 *
 * Without it this is a network request per keystroke — comfortably the chattiest
 * thing in the product, on the path a user touches most. The other two cases here
 * are the ones that leave a colleague permanently "about to answer": a claim not
 * withdrawn when the draft is abandoned, and a claim left standing on a thread the
 * user has navigated away from.
 */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TYPING_REFRESH_MS } from '@/lib/conversations/presence-contract'
import { useTypingBroadcast } from './use-typing-broadcast'

const fetchMock = vi.fn()

/** The `{ typing }` bodies posted so far, in order, with their conversation ids. */
function posts(): Array<{ conversationId: string; typing: boolean }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    conversationId: String(url).split('/')[3],
    typing: JSON.parse(String((init as RequestInit).body)).typing as boolean,
  }))
}

describe('useTypingBroadcast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    // Unmount BEFORE the fetch stub goes away: the hook withdraws its claim on
    // teardown, and a real `fetch` at that moment would try to reach a server.
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('posts nothing when disabled', () => {
    const { result } = renderHook(() =>
      useTypingBroadcast({ conversationId: 'conv_1', enabled: false })
    )
    act(() => result.current.onTyping())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('publishes once for a burst of keystrokes', () => {
    const { result } = renderHook(() =>
      useTypingBroadcast({ conversationId: 'conv_1', enabled: true })
    )
    act(() => {
      for (let i = 0; i < 40; i += 1) result.current.onTyping()
    })
    expect(posts()).toEqual([{ conversationId: 'conv_1', typing: true }])
  })

  it('republishes once the claim is due to expire', () => {
    const { result } = renderHook(() =>
      useTypingBroadcast({ conversationId: 'conv_1', enabled: true })
    )
    act(() => result.current.onTyping())
    act(() => {
      vi.advanceTimersByTime(TYPING_REFRESH_MS + 1)
      result.current.onTyping()
    })
    expect(posts()).toHaveLength(2)
    expect(posts().every((p) => p.typing)).toBe(true)
  })

  it('withdraws the claim when the draft is cleared', () => {
    const { result } = renderHook(() =>
      useTypingBroadcast({ conversationId: 'conv_1', enabled: true })
    )
    act(() => result.current.onTyping())
    act(() => result.current.onStoppedTyping())
    expect(posts()).toEqual([
      { conversationId: 'conv_1', typing: true },
      { conversationId: 'conv_1', typing: false },
    ])
  })

  it('does not withdraw a claim it never made', () => {
    const { result } = renderHook(() =>
      useTypingBroadcast({ conversationId: 'conv_1', enabled: true })
    )
    // Clearing an already-empty composer fires this on every render pass; turning
    // that into a request would undo the throttle from the other side.
    act(() => result.current.onStoppedTyping())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('withdraws on unmount', () => {
    const { result, unmount } = renderHook(() =>
      useTypingBroadcast({ conversationId: 'conv_1', enabled: true })
    )
    act(() => result.current.onTyping())
    unmount()
    expect(posts().at(-1)).toEqual({ conversationId: 'conv_1', typing: false })
  })

  it('withdraws on the OLD thread when the conversation changes', () => {
    const { result, rerender } = renderHook(
      (props: { conversationId: string }) =>
        useTypingBroadcast({ conversationId: props.conversationId, enabled: true }),
      { initialProps: { conversationId: 'conv_1' } }
    )
    act(() => result.current.onTyping())
    rerender({ conversationId: 'conv_2' })
    expect(posts().at(-1)).toEqual({ conversationId: 'conv_1', typing: false })
  })

  it('never surfaces a failed publish', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() =>
      useTypingBroadcast({ conversationId: 'conv_1', enabled: true })
    )
    // Presence that did not arrive costs a colleague two seconds of warning; it
    // must not become an error the person typing has to deal with.
    expect(() => act(() => result.current.onTyping())).not.toThrow()
  })
})
