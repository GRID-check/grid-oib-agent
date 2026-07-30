/**
 * A preview you can hover, tap, or pin.
 *
 * Shared rather than feature-local: this is the product's answer to "let me look
 * at that thing in passing" and it now serves citations, source chips and
 * @-mentions. Three surfaces with the same behaviour is a UI-system behaviour, and
 * three copies of this timing would drift.
 *
 * Checking a source — or who a colleague is — is a glance, not a decision.
 * Requiring a click to answer "what is this?" charges the reader a commitment —
 * and something they must then dismiss — for a question they wanted answered in
 * passing. So the peek follows the pointer: hover to see, move away to forget.
 *
 * But a peek that only follows the pointer is unusable the moment it holds
 * something to press ("open at this passage", "copy link"), because reaching
 * for that button means leaving the trigger. Hence two states:
 *
 *   hovered — opened by the pointer, closes when it leaves (after a grace
 *             period long enough to travel into the panel)
 *   pinned  — opened by a click or a key, stays until dismissed
 *
 * Touch has no hover, so a tap pins directly. Keyboard focus opens too: the
 * peek is content, and content reachable only by pointer is not reachable.
 *
 * Used with `PopoverAnchor` rather than `PopoverTrigger` — the trigger's own
 * click-to-toggle would fight the pinning here (clicking an already-hovered
 * trigger would read as "close"), so this owns the open state outright.
 */

'use client'

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'

/** Long enough that crossing a marker on the way somewhere else does not fire. */
const OPEN_DELAY_MS = 130
/** Long enough to travel from the trigger into the panel without it vanishing. */
const CLOSE_DELAY_MS = 220

interface TriggerProps {
  'aria-expanded': boolean
  'aria-haspopup': 'dialog'
  onPointerEnter: (event: PointerEvent) => void
  onPointerLeave: (event: PointerEvent) => void
  onFocus: () => void
  onBlur: () => void
  onClick: () => void
}

interface ContentProps {
  onPointerEnter: () => void
  onPointerLeave: () => void
  onOpenAutoFocus: (event: Event) => void
}

export interface HoverPopover {
  open: boolean
  /** For `<Popover open onOpenChange>` — carries Escape and outside clicks. */
  onOpenChange: (open: boolean) => void
  /** Spread onto the trigger element. */
  triggerProps: TriggerProps
  /** Spread onto `PopoverContent`. */
  contentProps: ContentProps
  /** Close and unpin — for an action inside the panel that supersedes it. */
  dismiss: () => void
}

export const useHoverPopover = (): HoverPopover => {
  const [open, setOpen] = useState(false)
  // A ref, not state: every handler below needs the CURRENT pinning, and a
  // pointer leaving mid-render must not read a stale one and close a panel the
  // reader just pinned.
  const pinned = useRef(false)
  const timer = useRef<number | null>(null)

  const cancel = useCallback((): void => {
    if (timer.current === null) return
    window.clearTimeout(timer.current)
    timer.current = null
  }, [])

  const schedule = useCallback(
    (next: boolean, delay: number): void => {
      cancel()
      timer.current = window.setTimeout(() => {
        timer.current = null
        setOpen(next)
      }, delay)
    },
    [cancel]
  )

  const dismiss = useCallback((): void => {
    cancel()
    pinned.current = false
    setOpen(false)
  }, [cancel])

  // A chip unmounted mid-hover (the answer re-rendered) must not wake up later
  // and set state on nothing.
  useEffect(() => cancel, [cancel])

  return {
    open,
    onOpenChange: (next) => {
      if (!next) dismiss()
    },
    dismiss,
    triggerProps: {
      'aria-expanded': open,
      'aria-haspopup': 'dialog',
      onPointerEnter: (event) => {
        // Touch and pen report through the same events but have no hover: for
        // them the "hover" is the tap that is about to arrive, and opening here
        // would make the panel appear before the finger lands.
        if (event.pointerType !== 'mouse') return
        schedule(true, OPEN_DELAY_MS)
      },
      onPointerLeave: (event) => {
        if (event.pointerType !== 'mouse') return
        if (pinned.current) {
          cancel()
          return
        }
        schedule(false, CLOSE_DELAY_MS)
      },
      onFocus: () => {
        cancel()
        setOpen(true)
      },
      onBlur: () => {
        // Scheduled, not immediate: clicking a button inside the panel blurs
        // the trigger, and the panel's own pointer-enter cancels this.
        if (!pinned.current) schedule(false, CLOSE_DELAY_MS)
      },
      onClick: () => {
        cancel()
        if (pinned.current) {
          dismiss()
          return
        }
        pinned.current = true
        setOpen(true)
      },
    },
    contentProps: {
      onPointerEnter: cancel,
      onPointerLeave: () => {
        if (!pinned.current) schedule(false, CLOSE_DELAY_MS)
      },
      onOpenAutoFocus: (event) => {
        // A panel that appeared because the pointer passed over something must
        // not take the keyboard with it. A pinned one asked for focus.
        if (!pinned.current) event.preventDefault()
      },
    },
  }
}
