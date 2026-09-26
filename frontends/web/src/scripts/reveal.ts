import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { gsap } from './motion-gsap'
import { MQ, STAGGER, TRAVEL, sec } from '../lib/motion'

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
 *
 * Opacity and a short rise, nothing else. This used to un-blur as well, and a
 * `filter` on a block the size of a panel is repainted every frame of the
 * tween, which is the one thing the performance budget in docs/ux/motion.md
 * rules out.
 */
export function initReveals() {
  gsap.matchMedia().add(MQ.motion, () => {
    const els = gsap.utils.toArray<HTMLElement>('[data-reveal]')
    const below = els.filter((el) => el.getBoundingClientRect().top > window.innerHeight * 0.92)
    gsap.set(below, { opacity: 0, y: TRAVEL.md })

    ScrollTrigger.batch(below, {
      start: 'top 88%',
      onEnter: (batch) =>
        gsap.to(batch, {
          opacity: 1,
          y: 0,
          duration: sec('slow'),
          ease: 'settle',
          stagger: STAGGER.row / 1000,
          overwrite: true,
          clearProps: 'transform',
        }),
    })
  })
}
