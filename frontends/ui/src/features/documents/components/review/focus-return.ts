/**
 * Where the focus goes back to in the review, for a reader on the keyboard:
 * a card, the crosshair or the cursor chat took it from something, and gives
 * it back there when it closes, unless the reader has put it somewhere else
 * meanwhile. (`shared/hooks/use-panel-focus.ts` does this for a panel that
 * always takes the focus; a review card takes it only when a key opened it,
 * and one card follows another under J without giving it back in between.)
 */

/**
 * What has the focus now, to give it back later; `current` when that is a
 * card or the crosshair (a step from one card to the next keeps the first
 * trigger) or nothing.
 */
export function keepTrigger(current: HTMLElement | null): HTMLElement | null {
  const active = document.activeElement
  return active instanceof HTMLElement &&
    active !== document.body &&
    !active.closest('[data-review-card], [data-testid="review-aim"]')
    ? active
    : current
}

/** Give the focus back to `trigger` when it was lost with what closed: on nothing, or on the review itself. */
export function restoreFocus(trigger: Element | null): void {
  if (!(trigger instanceof HTMLElement) || !trigger.isConnected) return
  const active = document.activeElement
  const lost = !active || active === document.body || (active instanceof HTMLElement && active.dataset.testid === 'document-review')
  if (lost) trigger.focus({ preventScroll: true })
}
