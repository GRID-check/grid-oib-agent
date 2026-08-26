import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

/**
 * Content arrives rather than snapping in.
 *
 * ScrollTrigger.batch is the reason this is six lines instead of an observer
 * and a hand-written stagger: it collects the elements that cross the line in
 * the same frame and hands them over together, so a row of cards arrives as a
 * row rather than as four independent animations that happen to overlap.
 *
 * Only what is below the fold at load starts hidden. Elements already on screen
 * are left alone — hiding them first and revealing them a frame later is how a
 * page ends up flashing its own content at whoever just opened it.
 */
export function initReveals() {
  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', () => {
    const els = gsap.utils.toArray<HTMLElement>('[data-reveal]')
    const below = els.filter((el) => el.getBoundingClientRect().top > window.innerHeight * 0.92)
    gsap.set(below, { opacity: 0, y: 18, filter: 'blur(6px)' })

    ScrollTrigger.batch(below, {
      start: 'top 88%',
      onEnter: (batch) =>
        gsap.to(batch, {
          opacity: 1,
          y: 0,
          filter: 'blur(0px)',
          duration: 0.9,
          ease: 'power3.out',
          stagger: 0.08,
          overwrite: true,
        }),
    })
  })
}
