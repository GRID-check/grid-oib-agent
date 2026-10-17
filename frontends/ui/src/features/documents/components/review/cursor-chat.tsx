'use client'

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { identityInk } from '@/components/ui/avatar-identity'
import { useTranslations } from '@/i18n'
import { CURSOR_CHAT_MAX } from '@/lib/annotations/room-types'
import { cn } from '@/lib/utils'
import { restoreFocus } from './focus-return'

/** How long a sent line stays beside the pointer after Enter, before it clears for everyone. */
export const CURSOR_CHAT_LINGER_MS = 4_000

/** The line still lingering from the last bubble: a new bubble takes over from it. One pointer, one line. */
let lingering: ReturnType<typeof setTimeout> | null = null

/** How far the bubble keeps from the canvas's edges, in CSS pixels. */
const EDGE = 8

/**
 * Where the bubble goes, in the window: beside the pointer (down and to the
 * right of its tip), or, opened with no pointer to follow (the toolbar's
 * button, a finger), centred over the canvas just above its toolbars (`foot`
 * pixels of them). Either way it is clamped inside the canvas, so it never
 * opens below the window's edge or over the list beside the sheet.
 */
export function placeChat(
  pointer: { x: number; y: number } | null,
  bounds: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
  foot: number
): { left: number; top: number } {
  const wanted = pointer
    ? { left: pointer.x + 14, top: pointer.y + 16 }
    : { left: bounds.left + (bounds.width - size.width) / 2, top: bounds.top + bounds.height - foot - size.height }
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)))
  return {
    left: clamp(wanted.left, bounds.left + EDGE, bounds.left + bounds.width - size.width - EDGE),
    top: clamp(wanted.top, bounds.top + EDGE, bounds.top + bounds.height - size.height - EDGE),
  }
}

/**
 * Cursor chat, the way a design tool has it: „/" opens a bubble at this
 * reader's own pointer, and every key they type shows beside their pointer
 * for everyone in the room as they type it, no send button and nothing
 * stored. It is for the moment in a Jour fixe when „hier" needs a word, not
 * for anything to keep: that is an Anmerkung.
 *
 * Enter keeps the line a moment longer ({@link CURSOR_CHAT_LINGER_MS}), then
 * it goes; Esc and leaving the field take it away at once. The bubble follows
 * the pointer, so the words stay where the hand is.
 */
export function CursorChat({
  userId,
  from,
  bounds,
  foot = 72,
  onChat,
  onClose,
}: {
  /** Where the reader's pointer last was, in the window: the bubble opens there. Null: opened without one. */
  from: { x: number; y: number } | null
  /** The canvas the bubble stays inside, read when it is placed. Default: the window. */
  bounds?: () => DOMRect | null
  /** How much of the canvas's foot its toolbars take: a bubble opened without a pointer sits above them. */
  foot?: number
  /** This reader, for their own colour: the room sees the bubble in it. */
  userId: string | null
  /** Say the line (null: take it away). The room's `sendChat`. */
  onChat: (text: string | null) => void
  onClose: () => void
}): JSX.Element {
  const t = useTranslations('files')
  const [text, setText] = useState('')
  const [at, setAt] = useState<{ x: number; y: number } | null>(from)
  /** Closed once, by Enter, Esc or leaving the field: the rest is the linger's or nothing. */
  const done = useRef(false)
  const field = useRef<HTMLInputElement | null>(null)
  const bubble = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 240, height: 64 })
  useLayoutEffect(() => {
    const node = bubble.current
    if (node && node.offsetWidth > 0) setSize({ width: node.offsetWidth, height: node.offsetHeight })
  }, [])
  const onChatRef = useRef(onChat)
  useEffect(() => {
    onChatRef.current = onChat
  })
  // „/" is the reader asking for this field: it takes the keys at once, and the last line's linger ends.
  // What had the focus gets it back when the bubble goes (Enter, Esc), unless the reader moved it.
  const before = useRef<Element | null>(null)
  useEffect(() => {
    before.current = document.activeElement
    if (lingering) clearTimeout(lingering)
    lingering = null
    // Without the scroll: focusing a field the browser thinks is off-screen
    // scrolled the whole review up to it.
    field.current?.focus({ preventScroll: true })
  }, [])

  // The bubble rides with the pointer; until it moves, it sits where the reader last pointed.
  // Opened without a pointer (the toolbar's button) it stays put: the hand is on the toolbar.
  const follows = from !== null
  useEffect(() => {
    if (!follows) return
    let frame = 0
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setAt({ x: event.clientX, y: event.clientY }))
    }
    window.addEventListener('pointermove', move)
    return () => {
      window.removeEventListener('pointermove', move)
      cancelAnimationFrame(frame)
    }
  }, [follows])

  // The bubble went without being closed (the review closed under it): its line goes with it.
  useEffect(
    () => () => {
      if (!done.current) onChatRef.current(null)
      const trigger = before.current
      requestAnimationFrame(() => restoreFocus(trigger))
    },
    []
  )

  const ink = identityInk(userId ?? 'me')
  const frame =
    bounds?.() ??
    (typeof window === 'undefined' ? null : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight })
  const place = frame ? placeChat(at, frame, size, foot) : { left: 0, top: 0 }
  const finish = (keep: boolean) => {
    if (done.current) return
    done.current = true
    // The line outlives the bubble for a moment: the timer is the room's, not this component's.
    if (keep && text.trim()) {
      const say = onChatRef.current
      lingering = setTimeout(() => {
        lingering = null
        say(null)
      }, CURSOR_CHAT_LINGER_MS)
    }
    else onChat(null)
    onClose()
  }

  return (
    <div
      ref={bubble}
      data-testid="cursor-chat"
      className={cn(
        'pointer-events-auto fixed z-50 w-60 px-3 py-2 text-white shadow-lg',
        // Beside a pointer, its corner points at the tip; on its own, a plain bubble.
        at ? 'rounded-2xl rounded-tl-sm' : 'rounded-2xl'
      )}
      style={{ backgroundColor: ink, left: place.left, top: place.top }}
    >
      <input
        ref={field}
        aria-label={t('review.chatOpen')}
        data-testid="cursor-chat-input"
        maxLength={CURSOR_CHAT_MAX}
        value={text}
        placeholder={t('review.chatPlaceholder')}
        // Solid white throughout (translucent white on a mid ink fails 4.5:1): what is typed is bolder than the placeholder.
        className="w-full rounded-md border-0 bg-transparent px-1 text-sm leading-5 font-semibold text-white shadow-none placeholder:font-normal placeholder:text-white pointer-coarse:text-base"
        // The app's focus outline stays (WCAG 2.4.11), in white on the bubble's colour, hugging the words.
        style={{ outlineColor: 'rgb(255 255 255 / 0.75)', outlineOffset: 1 }}
        onChange={(event) => {
          setText(event.target.value)
          onChat(event.target.value || null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            finish(false)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            finish(true)
          }
        }}
        onBlur={() => finish(true)}
      />
      <p className="mt-0.5 text-[10px] leading-3 text-white">{t('review.chatHint')}</p>
    </div>
  )
}
