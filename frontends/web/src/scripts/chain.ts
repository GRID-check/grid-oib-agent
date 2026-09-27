import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { MQ, STAGGER, TRAVEL, sec, staggerFor } from '../lib/motion'
import { gsap } from './motion-gsap'

gsap.registerPlugin(ScrollTrigger)

/**
 * The decision chain from `lg` up (components/molecules/ChatMock).
 *
 * The board is laid out by CSS in its finished state, and nothing here
 * measures it: the spine, the branch and the bus are elements sized by the
 * stylesheet, and this file only moves them with transform and opacity. What it
 * adds is the order. The stages light down the spine once, as the board comes
 * into view: the question, then the three sources together off one branch
 * (Piloti consults them at the same time), then the decision, then the steps.
 * The lime node is where the chain is, and it waits there while the next
 * stage is still below the fold.
 *
 * It plays once and stops on the finished chain; the pill holds it while it
 * runs (WCAG 2.2.2) and replays it afterwards. Below `lg` the phone stories
 * tell the chain; under reduced motion this never runs and the board stays as
 * the markup has it.
 */

/** A stagger in seconds, for GSAP (`staggerFor` counts in milliseconds). */
const stagger = (n: number, each?: number) => staggerFor(n, each) / 1000

/** How long each stage stays lit on its own before the chain moves on, in seconds. */
const READ = [1.4, 1.2, 1.4]

export function initChain() {
  const board = document.querySelector<HTMLElement>('[data-chain-board]')
  if (!board) return
  const all = <T extends Element = HTMLElement>(sel: string, root: ParentNode = board) =>
    Array.from(root.querySelectorAll<T>(sel))

  const stages = all('[data-stage]')
  const sheet = stages.map((st) => st.querySelector<HTMLElement>('[data-sheet]'))
  const done = stages.map((st) => st.querySelector<HTMLElement>('[data-node-done]'))
  const now = stages.map((st) => st.querySelector<HTMLElement>('[data-node-now]'))
  const seg = stages.map((st) => st.querySelector<HTMLElement>('[data-seg]'))
  const toggle = board.querySelector<HTMLButtonElement>('[data-chain-toggle]')
  if (stages.length !== 4 || sheet.some((el) => !el)) return

  const facts = all('[data-facts]')
  const branch = all('[data-branch]')
  const bus = all('[data-bus]')
  const ticks = all('[data-tick]')
  const srcs = all('[data-src]')
  const opts = all('[data-opt]')
  const field = all('[data-opt-field]')
  const ink = all<SVGPathElement>('[data-opt-ink]')
  const subs = all('[data-opt-sub]')
  const whys = all('[data-opt-why]')
  const steps = all('[data-step]')
  const checks = all<SVGPathElement>('[data-step-check]')
  const closing = all('[data-done]')
  const rise = () => ({ opacity: 1, y: 0 })

  gsap.matchMedia().add(`${MQ.staged} and ${MQ.motion}`, () => {
    // The opening state is set now, not when the timeline first plays: a
    // paused timeline renders nothing, so the finished chain would stand there
    // until the board scrolled into view and then snap back to the start.
    // What stays visible meanwhile is the spine with its empty nodes: where the
    // chain will go.
    gsap.set([...sheet, ...srcs, ...opts, ...steps, ...closing], { opacity: 0, y: TRAVEL.sm })
    gsap.set([...done, ...now, ...facts, ...field, ...whys], { opacity: 0 })
    gsap.set(subs, { opacity: 1 })
    gsap.set(seg, { scaleY: 0 })
    gsap.set([...branch, ...bus, ...ticks], { scale: 0 })
    gsap.set([...ink, ...checks], { strokeDashoffset: 1 })

    const tl = gsap.timeline({ paused: true, defaults: { duration: sec('slow'), ease: 'settle' }, onComplete: () => sync() })

    // A stage lights only where the reader can see it. On a short screen (1024
    // by 768) the board is taller than the window, and the last two stages
    // used to play out below the fold: the chain waits at the node it has
    // reached until the next stage has scrolled into view.
    const seen = stages.map(() => false)
    let waiting = -1
    /** The spine runs on from stage `i - 1` to stage `i`, whose sheet arrives. */
    const reach = (i: number, after: number) => {
      tl.call(
        () => {
          if (seen[i]) return
          waiting = i
          tl.pause()
        },
        [],
        `+=${after}`
      )
      tl.to(seg[i - 1], { scaleY: 1, duration: sec('base'), ease: 'draft' }, '>')
        .to(done[i - 1], { opacity: 1, duration: sec('quick') }, '<')
        .to(now[i - 1], { opacity: 0, duration: sec('quick') }, '<')
        .to(now[i], { opacity: 1, duration: sec('quick') }, '>')
        .to(sheet[i], rise(), '<')
    }

    // 1 · the question
    tl.to(now[0], { opacity: 1, duration: sec('quick') }).to(sheet[0], rise(), '<').to(facts, { opacity: 1 }, '<0.24')

    // 2 · the sources, fetched together: one branch, one bus, three cards at once.
    reach(1, READ[0])
    tl.to(branch, { scale: 1, duration: sec('quick'), ease: 'draft' }, '<0.16')
      .to(bus, { scale: 1, duration: sec('quick'), ease: 'none', stagger: sec('quick') / bus.length }, '>')
      .to(ticks, { scale: 1, duration: sec('quick'), ease: 'draft' }, '<0.12')
      .to(srcs, { ...rise(), stagger: stagger(srcs.length) }, '<0.06')

    // 3 · the decision: three ways, then B is ringed and each says why.
    reach(2, READ[1])
    tl.to(opts, { ...rise(), stagger: stagger(opts.length) }, '<0.12')
      .to(field, { opacity: 1, duration: sec('base') }, '+=0.5')
      .to(ink, { strokeDashoffset: 0, ease: 'draft' }, '<')
      .to(subs, { opacity: 0, duration: sec('quick') }, '+=0.1')
      .to(whys, { opacity: 1, duration: sec('base') }, '>')

    // 4 · the steps tick off, one by one, and the chain closes.
    reach(3, READ[2])
    tl.to(steps, { ...rise(), stagger: stagger(steps.length) }, '<0.12')
      .to(checks, { strokeDashoffset: 0, duration: sec('quick'), ease: 'draft', stagger: stagger(checks.length, STAGGER.max) }, '>-0.1')
      .to(closing, rise(), '>0.1')

    // Held by the reader, it stays held: scrolling away and back does not
    // resume what they stopped.
    let held = false
    let inView = false
    const sync = () => {
      const finished = tl.progress() >= 1
      if (inView && !held && !finished && waiting < 0) tl.play()
      else tl.pause()
      if (!toggle) return
      const label = finished ? 'labelReplay' : held ? 'labelResume' : 'labelPause'
      toggle.textContent = toggle.dataset[label] ?? ''
      if (finished) toggle.removeAttribute('aria-pressed')
      else toggle.setAttribute('aria-pressed', String(held))
    }
    const trigger = ScrollTrigger.create({
      trigger: board,
      start: 'top 75%',
      end: 'bottom 10%',
      onToggle: (self) => {
        inView = self.isActive
        sync()
      },
    })
    const gates = stages.map((stage, i) =>
      ScrollTrigger.create({
        trigger: stage,
        start: 'top 90%',
        onEnter: () => {
          seen[i] = true
          if (waiting !== i) return
          waiting = -1
          sync()
        },
      })
    )
    const onToggle = () => {
      if (tl.progress() >= 1) {
        held = false
        tl.restart()
      } else held = !held
      sync()
    }
    if (toggle) {
      toggle.hidden = false
      toggle.addEventListener('click', onToggle)
    }
    sync()

    return () => {
      toggle?.removeEventListener('click', onToggle)
      if (toggle) toggle.hidden = true
      trigger.kill()
      gates.forEach((g) => g.kill())
      tl.kill()
    }
  })
}
