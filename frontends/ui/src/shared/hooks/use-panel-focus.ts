'use client'

import { useEffect, useRef, type RefObject } from 'react'

const isTextEntry = (el: Element | null): boolean => {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

/**
 * Focus management for an open/close surface that behaves like a dialog
 * (the docked side panels and the research panel).
 *
 * On the `false → true` transition of `open` it:
 *   - records the element that had focus (the "opener" — normally the toolbar
 *     toggle that opened the panel) so it can be restored later, and
 *   - moves focus into the panel by focusing `initialFocusRef` (its close
 *     button).
 *
 * Both steps are skipped when focus is currently in a text-entry field, so an
 * auto-open — the research panel opens itself when a run starts, which can
 * happen while the user is typing — never steals the caret.
 *
 * The initial render is never treated as an open transition: a panel that
 * starts open (the data-sources panel defaults open on load) must not grab
 * focus on mount.
 *
 * Returns `restoreFocus`, which sends focus back to the recorded opener.
 * Callers invoke it from their Escape handler so keyboard users land back on
 * the toggle that opened the panel. Returning focus to the previously-focused
 * element (rather than a hard-coded ref into the toolbar) keeps the panel
 * decoupled from whichever control opened it and is robust to programmatic
 * opens.
 *
 * SSR-safe: all DOM access is confined to an effect / the returned callback.
 */
export function usePanelFocus(
  open: boolean,
  initialFocusRef: RefObject<HTMLElement | null>,
): { restoreFocus: () => void } {
  const openerRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(open)

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current
    wasOpenRef.current = open
    if (!justOpened) return
    if (typeof document === 'undefined') return

    const active = document.activeElement
    // Don't yank the caret out of a field on an auto-open.
    if (isTextEntry(active)) return

    openerRef.current = active instanceof HTMLElement ? active : null
    initialFocusRef.current?.focus()
  }, [open, initialFocusRef])

  // Stable identity: the closure reads the (stable) ref at call time.
  const restoreFocus = useRef(() => {
    openerRef.current?.focus()
    openerRef.current = null
  }).current

  return { restoreFocus }
}
