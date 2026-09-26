import { gsap } from 'gsap'
import { CustomEase } from 'gsap/CustomEase'
import { EASE, type Ease } from '../lib/motion'

gsap.registerPlugin(CustomEase)

/**
 * The motion tokens' easings, registered with GSAP under their own names, so
 * a timeline says `ease: 'settle'` and means exactly the curve CSS means by
 * `var(--ease-settle)`. Importing this module is the registration; it runs
 * once however many scripts import it.
 */
for (const [name, [x1, y1, x2, y2]] of Object.entries(EASE) as [Ease, readonly number[]][]) {
  CustomEase.create(name, `${x1},${y1},${x2},${y2}`)
}

export { gsap }
