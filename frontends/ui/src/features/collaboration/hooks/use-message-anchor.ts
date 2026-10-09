'use client'

/**
 * Land on the MESSAGE a notification was about, not merely on its conversation.
 *
 * An inbox row for "Anna asked for your input" links to
 * `…/chat?session=<id>#message-<messageId>` (see `lib/sharing/registry.ts`). The
 * query half selects the thread; this hook is the other half. A plain browser
 * hash cannot do it: the thread is fetched after navigation, so at the moment the
 * browser looks for `#message-…` the element does not exist yet, and the reader is
 * dropped at the bottom of a thread with no idea which of forty messages concerns
 * them — while the inbox row is marked read, spending their only signal.
 *
 * So the hash is captured once and held until the message actually renders, then
 * scrolled to and briefly marked. Held rather than polled: the trigger is the
 * message list changing, which is exactly when the answer can change. A hash
 * that changes while the thread is open (an in-app link to another message)
 * is taken up the same way.
 *
 * The thread's own scroll controller jumps to the bottom when a thread opens,
 * and follows growth below. Both used to run after this landed and override it:
 * the reader arrived at the bottom after all. So the caller asks
 * `isTargetPending()` before it moves the thread, and `onLand` tells it the
 * reader is now somewhere on purpose.
 *
 * A target that never resolves must not hold the thread forever. The link names
 * a message that is not displayable, was deleted, or sits in a thread that was
 * refused, and a target pending for good left every later thread unplaced and
 * unfollowed. So once the open thread's messages are all here (`ready`) without
 * it, the target stops holding that thread, and leaving such a thread for one
 * the link does not name drops the target altogether. It is not dropped at the
 * first miss: a shared thread's newest message (what an inbox link is about)
 * can land with its history a moment after a stale local copy rendered.
 *
 * Returns the id to highlight, or null. Rendering is the caller's business — the
 * hook does not touch classes, and the mark fades on its own so the thread does
 * not keep a permanent decoration nobody asked for.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the arrival mark stays before the thread settles to normal. */
const HIGHLIGHT_MS = 2600

const ANCHOR_PREFIX = '#message-'

/** The message id in a `#message-<id>` hash, or null for anything else. */
export function messageIdFromHash(hash: string | null | undefined): string | null {
  if (!hash || !hash.startsWith(ANCHOR_PREFIX)) return null
  const id = decodeURIComponent(hash.slice(ANCHOR_PREFIX.length))
  return id.length > 0 ? id : null
}

export interface MessageAnchorOptions {
  /** The target was scrolled to: the reader is where the link put them. */
  onLand?: (messageId: string) => void
  /** The thread on screen. */
  conversationId?: string | null
  /**
   * Whether the thread on screen has all its messages: a target missing from
   * them then is missing from the thread. Until a caller says so, a target
   * holds the thread until it lands.
   */
  ready?: boolean
}

export interface MessageAnchor {
  /** The message wearing the arrival mark, or null. */
  highlightedId: string | null
  /**
   * A target is captured, has not landed, and is not known to be missing from
   * the open thread: the thread must not be moved.
   */
  isTargetPending: () => boolean
}

/** The thread a link's `?session=` names, which its target belongs to. */
const sessionFromUrl = (): string | null =>
  typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('session')

export function useMessageAnchor(
  messageIds: readonly string[],
  { onLand, conversationId = null, ready = false }: MessageAnchorOptions = {}
): MessageAnchor {
  // Captured on mount and NOT re-read on render: the hash is consumed below (so
  // a refresh does not re-scroll a thread the reader has since scrolled away
  // from), and reading it again after that would clear the pending target
  // mid-flight. A later `hashchange` replaces it (below).
  const pendingRef = useRef<string | null | undefined>(undefined)
  // The thread the target belongs to: the link's `?session=`, or the open
  // thread for a hash that changes in it. Null when the link named none.
  const boundRef = useRef<string | null>(null)
  if (pendingRef.current === undefined) {
    pendingRef.current =
      typeof window === 'undefined' ? null : messageIdFromHash(window.location.hash)
    boundRef.current = sessionFromUrl()
  }
  const onLandRef = useRef(onLand)
  onLandRef.current = onLand

  // Decided during the render, not in an effect: the caller asks
  // `isTargetPending()` from its layout effects in this same commit, before
  // any effect here has run, and a thread that loaded without the target
  // must be placed in the commit it loaded.
  const shownRef = useRef(conversationId)
  // The last thread that was open, complete, and without the target.
  const missedInRef = useRef<string | null | undefined>(undefined)
  const blockingRef = useRef(false)
  if (shownRef.current !== conversationId) {
    // Left a thread that had its chance, for one the link does not name: the
    // reader has moved on, and the target goes with the thread it missed in.
    if (missedInRef.current === shownRef.current && conversationId !== boundRef.current) {
      pendingRef.current = null
    }
    shownRef.current = conversationId
  }
  const missing = Boolean(pendingRef.current) && ready && !messageIds.includes(pendingRef.current ?? '')
  if (missing) missedInRef.current = conversationId
  blockingRef.current = Boolean(pendingRef.current) && !missing

  const [highlighted, setHighlighted] = useState<string | null>(null)
  // Bumped by a hash change, so the resolution below runs without waiting for
  // the message list to change.
  const [hashTick, setHashTick] = useState(0)

  useEffect(() => {
    const onHashChange = () => {
      const target = messageIdFromHash(window.location.hash)
      if (!target) return
      pendingRef.current = target
      boundRef.current = shownRef.current
      missedInRef.current = undefined
      blockingRef.current = true
      setHashTick((tick) => tick + 1)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    const target = pendingRef.current
    if (!target || !messageIds.includes(target)) return

    const element = document.getElementById(`message-${target}`)
    // The id is in the list but the node has not painted yet — stay pending and
    // try again on the next render rather than giving up on this arrival.
    if (!element) return

    pendingRef.current = null
    blockingRef.current = false
    // Instant, not smooth: the thread was just opened, and a smooth scroll
    // across it was a blur of forty messages, during which the mark's fade had
    // already begun. The reader sees the message, marked, from the first frame.
    element.scrollIntoView({ behavior: 'auto', block: 'center' })
    setHighlighted(target)
    onLandRef.current?.(target)

    // Drop the hash so a reload lands the reader where they are, not back here.
    // `replaceState` rather than a router call: this must not add a history entry
    // and must not re-render the route.
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [messageIds, hashTick])

  // The fade owns its own effect, keyed on the mark rather than on the message
  // list. Sharing one effect with the resolution above looked tidier and did not
  // work: `messageIds` is a fresh array on most renders, so setting the mark
  // re-ran the effect, cleared its own timer, and then bailed out at the
  // already-consumed target — leaving the highlight on the thread for good.
  //
  // Counted from the frame the mark is painted at its place, not from the
  // resolution: the reader has to SEE it for the whole of its time.
  useEffect(() => {
    if (!highlighted) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS)
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [highlighted])

  const isTargetPending = useCallback(() => blockingRef.current, [])

  return { highlightedId: highlighted, isTargetPending }
}
