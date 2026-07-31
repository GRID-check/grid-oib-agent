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

/**
 * How long the claim survives without a keystroke before it is withdrawn.
 *
 * Long enough to cover thinking mid-sentence or glancing at a document; short
 * enough that a composer left open with a half-written draft in it stops
 * claiming somebody is at the keyboard.
 */
const TYPING_IDLE_MS = 45_000

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
  const lastKeystrokeAtRef = useRef(0)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const publish = useCallback((typing: boolean, conversation?: string) => {
    const id = conversation ?? conversationIdRef.current
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

  /*
    Keep the claim alive across a PAUSE, not just across keystrokes.

    The claim was refreshed only by a key press, and it expires after
    `TYPING_TTL_MS` (6s). So a colleague who stops mid-sentence to think, or to
    check a document — the ordinary rhythm of writing anything considered —
    dropped off the reader's screen and popped back on the next keypress. A
    flickering indicator is worse than none: it reads as a person who keeps
    changing their mind about answering.

    Bounded by `TYPING_IDLE_MS` rather than running forever, because a composer
    left open with text in it is not somebody writing. When that runs out the
    heartbeat withdraws the claim rather than just falling silent, so the reader
    learns it from an event instead of waiting out the TTL.
  */
  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current === null) return
    clearInterval(heartbeatRef.current)
    heartbeatRef.current = null
  }, [])

  const onStoppedTyping = useCallback(() => {
    stopHeartbeat()
    // No outstanding claim means nothing to withdraw, and withdrawing anyway
    // would turn "cleared an already-empty box" into a request.
    if (lastPublishedAtRef.current === 0) return
    lastPublishedAtRef.current = 0
    publish(false)
  }, [publish, stopHeartbeat])

  const onTyping = useCallback(() => {
    if (!enabledRef.current) return
    const now = Date.now()
    lastKeystrokeAtRef.current = now
    if (heartbeatRef.current === null) {
      heartbeatRef.current = setInterval(() => {
        if (Date.now() - lastKeystrokeAtRef.current > TYPING_IDLE_MS) {
          onStoppedTyping()
          return
        }
        lastPublishedAtRef.current = Date.now()
        publish(true)
      }, TYPING_REFRESH_MS)
    }
    if (now - lastPublishedAtRef.current < TYPING_REFRESH_MS) return
    lastPublishedAtRef.current = now
    publish(true)
  }, [publish, onStoppedTyping])

  // Withdraw on the way out: switching conversation, navigating away, unmounting.
  // Reads the ids from refs at cleanup time so the effect does not re-run (and
  // therefore does not withdraw) on every render.
  useEffect(
    () => () => {
      stopHeartbeat()
      if (lastPublishedAtRef.current === 0) return
      lastPublishedAtRef.current = 0
      publish(false)
    },
    [publish, stopHeartbeat]
  )

  // Switching conversation must not leave a claim standing on the OLD thread.
  const previousConversationRef = useRef(conversationId)
  useEffect(() => {
    const previous = previousConversationRef.current
    previousConversationRef.current = conversationId
    if (previous === conversationId || lastPublishedAtRef.current === 0) return
    stopHeartbeat()
    lastPublishedAtRef.current = 0
    if (!previous) return
    // Same request as every other withdrawal — `publish` takes the conversation
    // explicitly so this path cannot drift from it.
    publish(false, previous)
  }, [conversationId, publish, stopHeartbeat])

  return { onTyping, onStoppedTyping }
}
