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
 *
 * The panel is mounted LAZILY. An answer carries dozens of these triggers and
 * almost none is ever looked at, but a Radix `Popover` wrapped around each one
 * (Popper, Presence, the anchor's measuring effects) made a twenty-message
 * conversation mount some 1,500 fibers nobody would use. So `engaged` stays
 * false until the first sign of interest (pointer enter, pointer down, focus,
 * click), and {@link HoverPeekPanel} renders nothing before it. It renders the
 * popover BESIDE the trigger, anchored through `anchorRef`, never around it:
 * wrapping the trigger on engagement would change its position in the tree,
 * React would remount the button, and the focus or the tap that engaged it
 * would land on a node that no longer exists.
 */

'use client'

import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'

/** Long enough that crossing a marker on the way somewhere else does not fire. */
const OPEN_DELAY_MS = 130
/** Long enough to travel from the trigger into the panel without it vanishing. */
const CLOSE_DELAY_MS = 220
/**
 * How long after a peek closed the next one still opens at once.
 *
 * Reading a run of citations is moving from one marker to the next, and the
 * open delay that stops a passing pointer from firing a peek is the wrong
 * question once the reader is already reading peeks: the second marker waited
 * 130ms for nothing, while the first one's panel lingered through its 220ms
 * close grace on top of it. Radix's tooltip calls this `skipDelayDuration`.
 * A little over the close grace, so the hop survives the old panel's timer.
 */
const WARM_WINDOW_MS = 300

/**
 * The one peek a pointer or the keyboard has open, across every trigger on
 * the page. Module-level because the triggers are siblings in unrelated
 * subtrees (a marker in the prose, a chip in the sources row) with no common
 * owner to hold it, and there is only ever one pointer.
 */
interface OpenPeek {
  /** Close with no exit animation: the next panel is already taking its place. */
  replace: () => void
  isPinned: () => boolean
}
let currentPeek: OpenPeek | null = null
let lastClosedAt = Number.NEGATIVE_INFINITY

/** Another peek is open, or one closed a moment ago: the reader is reading peeks. */
const isWarm = (self: OpenPeek): boolean =>
  (currentPeek !== null && currentPeek !== self && !currentPeek.isPinned()) ||
  performance.now() - lastClosedAt < WARM_WINDOW_MS

interface TriggerProps {
  /** The element the panel anchors to. A callback, so any trigger element type fits. */
  ref: (node: HTMLElement | null) => void
  'aria-expanded': boolean
  'aria-haspopup': 'dialog'
  onPointerEnter: (event: PointerEvent) => void
  onPointerLeave: (event: PointerEvent) => void
  onPointerDown: () => void
  onFocus: () => void
  onBlur: () => void
  onClick: () => void
}

interface ContentProps {
  onPointerEnter: () => void
  onPointerLeave: () => void
  onOpenAutoFocus: (event: Event) => void
  onInteractOutside: (event: Event) => void
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
  /**
   * The trigger has been interacted with at least once, so the panel may
   * mount. Sticky: once mounted it stays, so its close animation can play.
   */
  engaged: boolean
  /** The trigger element, for the panel's `PopoverAnchor virtualRef`. */
  anchorRef: RefObject<HTMLElement | null>
  /**
   * This panel is closing because another one replaced it: skip the exit, so
   * the two never stand on screen together.
   */
  skipExit: boolean
}

export const useHoverPopover = (): HoverPopover => {
  const [open, setOpen] = useState(false)
  const [engaged, setEngaged] = useState(false)
  const [skipExit, setSkipExit] = useState(false)
  const anchorRef = useRef<HTMLElement | null>(null)
  // A ref, not state: every handler below needs the CURRENT pinning, and a
  // pointer leaving mid-render must not read a stale one and close a panel the
  // reader just pinned.
  const pinned = useRef(false)
  const timer = useRef<number | null>(null)

  const setAnchor = useCallback((node: HTMLElement | null): void => {
    anchorRef.current = node
  }, [])

  // Read from this render's closure: a trigger already engaged schedules no
  // update at all, so hovering an engaged chip costs what it always did.
  const engage = (): void => {
    if (!engaged) setEngaged(true)
  }

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
        if (next) setSkipExit(false)
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

  // This trigger's entry in the page-wide registry. Created once, so
  // `currentPeek === self` is an identity check, not a comparison of freshly
  // built objects. Everything it closes over is stable (refs, setters, `cancel`).
  const [self] = useState<OpenPeek>(() => ({
    replace: () => {
      cancel()
      pinned.current = false
      setSkipExit(true)
      setOpen(false)
    },
    isPinned: () => pinned.current,
  }))

  // Opening takes the page's one slot and closes whichever transient peek held
  // it; closing gives the slot up and starts the warm window.
  useEffect(() => {
    if (open) {
      if (currentPeek && currentPeek !== self && !currentPeek.isPinned()) currentPeek.replace()
      currentPeek = self
      return
    }
    if (currentPeek === self) {
      currentPeek = null
      lastClosedAt = performance.now()
    }
  }, [open, self])

  // Unmounted while open (the answer re-rendered under the pointer): free the
  // slot rather than leave a dead entry that every later peek would try to close.
  useEffect(
    () => () => {
      if (currentPeek === self) currentPeek = null
    },
    [self]
  )

  const show = (): void => {
    setSkipExit(false)
    setOpen(true)
  }

  return {
    open,
    skipExit,
    onOpenChange: (next) => {
      if (!next) dismiss()
    },
    dismiss,
    engaged,
    anchorRef,
    triggerProps: {
      ref: setAnchor,
      'aria-expanded': open,
      'aria-haspopup': 'dialog',
      onPointerEnter: (event) => {
        // Every pointer type engages — a finger reports pointerenter just
        // before pointerdown — so the panel is mounted, closed, before the
        // click that will open it.
        engage()
        // Touch and pen report through the same events but have no hover: for
        // them the "hover" is the tap that is about to arrive, and opening here
        // would make the panel appear before the finger lands.
        if (event.pointerType !== 'mouse') return
        if (isWarm(self)) {
          cancel()
          show()
          return
        }
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
      // A second chance for a pointer that never reported an enter (a pen, a
      // synthetic event); a no-op once engaged.
      onPointerDown: engage,
      onFocus: () => {
        engage()
        cancel()
        show()
      },
      onBlur: () => {
        // Scheduled, not immediate: clicking a button inside the panel blurs
        // the trigger, and the panel's own pointer-enter cancels this.
        if (!pinned.current) schedule(false, CLOSE_DELAY_MS)
      },
      onClick: () => {
        engage()
        cancel()
        if (pinned.current) {
          dismiss()
          return
        }
        pinned.current = true
        show()
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
      // The trigger is not "outside". It is an anchor, not a Radix trigger, so
      // to the dismissable layer a press on it is a press elsewhere: the
      // reader hovered a chip, its peek opened, they clicked to pin it — and
      // the click pinned it while the pointerdown that preceded it closed it.
      // The trigger's own `onClick` owns what a press on it means.
      onInteractOutside: (event) => {
        const target = event.target
        if (target instanceof Node && anchorRef.current?.contains(target)) event.preventDefault()
      },
    },
  }
}
