/**
 * Arrival for a mark made on the sheet: the Prüfblatt's ticks draw, once, when
 * the list scrolls into view.
 *
 * Not reveal.ts: that one moves content in batches through GSAP, and a tick
 * arriving that way would read as content, not as a mark. This only toggles
 * two classes; the motion itself is CSS in the component.
 *
 * Elements are hidden only by the class this script adds (`craft-armed`), so a
 * page whose script never runs shows every object in its final state. Under
 * `prefers-reduced-motion: reduce` nothing is armed at all.
 *
 * Imported as a module by Quellen.astro (the Prüfblatt); a module runs once
 * however many components import it.
 */
function arm() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  if (!('IntersectionObserver' in window)) return
  const els = document.querySelectorAll<HTMLElement>('[data-craft-in]:not(.craft-armed)')
  if (els.length === 0) return

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('craft-in')
        io.unobserve(entry.target)
      }
    },
    // Half the object on screen, and no shrunken root margin: an object in the
    // footer sits within a few pixels of the end of the page, and a margin
    // that the page cannot scroll past would leave it armed, i.e. invisible.
    { threshold: 0.5 },
  )
  for (const el of els) {
    el.classList.add('craft-armed')
    io.observe(el)
  }
}

arm()
