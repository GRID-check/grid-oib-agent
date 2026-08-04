import { scrollInfo } from 'motion'

/**
 * Drives the drafting-sheet marker in the page margin.
 *
 * The label tracks whichever section owns the middle of the viewport, and is
 * shown only where there is a margin to write in. Two properties of the section
 * itself decide that, so the answer does not depend on the order elements
 * happen to appear in its markup:
 *
 * - a section that spans the viewport is full-bleed (the hero, the pinned
 *   story) and has no margin at all — the marker would land on the artwork;
 * - a section inset inside the content column has one, and its own content edge
 *   is where the marker must stop.
 *
 * The hero and the story are therefore unmarked by design: the index begins
 * where the document does.
 */
export function initSheetIndex() {
  const marker = document.querySelector<HTMLElement>('[data-sheet-index]')
  const label = marker?.querySelector<HTMLElement>('[data-sheet-label]')
  if (!marker || !label) return

  const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-screen-label]'))
  if (!sections.length) return

  const MARGIN = 56
  let shown: string | null = null
  // getComputedStyle forces style resolution, and `apply` runs every scroll
  // frame — the padding only changes on resize, so it is cached until then.
  let padding = new WeakMap<HTMLElement, number>()
  const contentLeft = (el: HTMLElement) => {
    let pad = padding.get(el)
    if (pad === undefined) {
      pad = parseFloat(getComputedStyle(el).paddingLeft) || 0
      padding.set(el, pad)
    }
    return el.getBoundingClientRect().left + pad
  }

  const apply = () => {
    const mid = window.innerHeight / 2
    const current = sections.find((s) => {
      const r = s.getBoundingClientRect()
      return r.top <= mid && r.bottom >= mid
    })
    const text = current?.dataset.screenLabel ?? ''
    // clientWidth, not innerWidth: innerWidth includes the scrollbar, which
    // would make every full-bleed section look narrower than the viewport.
    const viewport = document.documentElement.clientWidth
    const bleeds = current ? current.getBoundingClientRect().width >= viewport : true
    const visible = Boolean(text) && !bleeds && contentLeft(current!) >= MARGIN

    if (text && text !== shown) {
      shown = text
      label.textContent = text
    }
    marker.style.opacity = visible ? '1' : '0'
  }

  apply()
  scrollInfo(apply)
  window.addEventListener('resize', () => {
    padding = new WeakMap()
    apply()
  })
}
