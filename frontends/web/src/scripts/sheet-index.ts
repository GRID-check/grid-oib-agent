import { scrollInfo } from 'motion'

/**
 * Drives the drafting-sheet marker in the page margin.
 *
 * The label tracks whichever section owns the middle of the viewport. It is
 * only shown when the margin can actually hold it — measured from the section's
 * own left edge, so a full-bleed panel (the story) hides it and a section inset
 * inside the content column reveals it. No breakpoint decides this.
 */
export function initSheetIndex() {
  const marker = document.querySelector<HTMLElement>('[data-sheet-index]')
  const label = marker?.querySelector<HTMLElement>('[data-sheet-label]')
  if (!marker || !label) return

  const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-screen-label]'))
  if (!sections.length) return

  const MARGIN = 56
  let shown: string | null = null

  const apply = () => {
    const mid = window.innerHeight / 2
    const current = sections.find((s) => {
      const r = s.getBoundingClientRect()
      return r.top <= mid && r.bottom >= mid
    })
    // The panel inside the section is what claims the margin, not the section.
    const panel = current?.firstElementChild ?? current
    const room = panel ? panel.getBoundingClientRect().left : 0
    const text = current?.dataset.screenLabel ?? ''
    const visible = Boolean(text) && room >= MARGIN

    if (text && text !== shown) {
      shown = text
      label.textContent = text
    }
    marker.style.opacity = visible ? '1' : '0'
  }

  apply()
  scrollInfo(apply)
  window.addEventListener('resize', apply)
}
