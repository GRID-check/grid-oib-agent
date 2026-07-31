'use client'

/**
 * Tell the thread you are composing.
 *
 * The composer calls {@link UseTypingBroadcastResult.onTyping} on every keystroke;
 * this turns that into at most one small POST every {@link TYPING_REFRESH_MS} for
 * as long as typing continues, and one final withdrawal when it stops. The ratio
 * matters — a request per keypress would be the single chattiest thing in the
 * product, and the server-side claim is deliberately long-lived enough that the
 * gaps between publishes are invisible.
 *
 * Three things end a claim early, all of which are "the draft is no longer being
 * written": the message was sent, the box was emptied, or the component went away
 * (navigated off, switched conversation, closed the tab). Everything else is left
 * to the server-side expiry, because a browser cannot be relied upon to say
 * goodbye.
 *
 * **Silent by design.** Nothing here reports a failure, retries, or surfaces
 * state: presence that did not arrive is a colleague who did not get two seconds
 * of warning, and the message itself is entirely unaffected.
 */

import { useCallback, useEffect, useRef } from 'react'
import { TYPING_REFRESH_MS } from '@/lib/conversations/presence-contract'

export interface UseTypingBroadcastOptions {
  conversationId: string | null
  /**
   * Off for a private thread, a gated org, and a reader who may not contribute.
   * The server enforces all three; this keeps a request from being made at all.
   */
  enabled: boolean
}

export interface UseTypingBroadcastResult {
  /** Call on every composer change. Cheap: throttled internally. */
  onTyping: () => void
  /** Call when the draft is sent or cleared. Idempotent. */
  onStoppedTyping: () => void
}

export function useTypingBroadcast(
  options: UseTypingBroadcastOptions,
): UseTypingBroadcastResult {
  const { conversationId, enabled } = options

  /** When the current claim was last published; 0 means "no claim outstanding". */
  const lastPublishedAtRef = useRef(0)
  // Read inside stable callbacks, so the composer's handlers are not rebuilt (and
  // its memoised subtree not re-rendered) every time either of these changes.
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const publish = useCallback((typing: boolean) => {
    const id = conversationIdRef.current
    if (!id) return
    void fetch(`/api/conversations/${encodeURIComponent(id)}/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ typing }),
      // Survives the tab closing, which is the one moment a withdrawal is most
      // useful and an ordinary fetch is most likely to be cancelled.
      keepalive: true,
    }).catch(() => {
      // Deliberately silent — see the module comment.
    })
  }, [])

  const onTyping = useCallback(() => {
    if (!enabledRef.current) return
    const now = Date.now()
    if (now - lastPublishedAtRef.current < TYPING_REFRESH_MS) return
    lastPublishedAtRef.current = now
    publish(true)
  }, [publish])

  const onStoppedTyping = useCallback(() => {
    // No outstanding claim means nothing to withdraw, and withdrawing anyway
    // would turn "cleared an already-empty box" into a request.
    if (lastPublishedAtRef.current === 0) return
    lastPublishedAtRef.current = 0
    publish(false)
  }, [publish])

  // Withdraw on the way out: switching conversation, navigating away, unmounting.
  // Reads the ids from refs at cleanup time so the effect does not re-run (and
  // therefore does not withdraw) on every render.
  useEffect(
    () => () => {
      if (lastPublishedAtRef.current === 0) return
      lastPublishedAtRef.current = 0
      publish(false)
    },
    [publish]
  )

  // Switching conversation must not leave a claim standing on the OLD thread.
  const previousConversationRef = useRef(conversationId)
  useEffect(() => {
    const previous = previousConversationRef.current
    previousConversationRef.current = conversationId
    if (previous === conversationId || lastPublishedAtRef.current === 0) return
    lastPublishedAtRef.current = 0
    if (!previous) return
    void fetch(`/api/conversations/${encodeURIComponent(previous)}/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ typing: false }),
      keepalive: true,
    }).catch(() => {})
  }, [conversationId])

  return { onTyping, onStoppedTyping }
}
