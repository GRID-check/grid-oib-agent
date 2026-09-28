import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { MQ, STAGGER, TRAVEL, sec, staggerFor } from '../lib/motion'
import { gsap } from './motion-gsap'

gsap.registerPlugin(DrawSVGPlugin, ScrollTrigger)

/**
 * The decision chain from `lg` up (components/molecules/ChatMock).
 *
 * The board is a wired graph read left to right: the question, its three
 * sources on one stem, curved wires merging into the decision, and from the
 * chosen way a wire on down to the steps. CSS lays the cards out at their
 * true size; this file draws the wires between them and adds the arrival.
 *
 * The wires are derived, never authored. Each starts and ends on a measured
 * box or on a port (a real element inside a card: the decision's list of
 * ways, the chosen way), and they are re-derived whenever the board changes size, so a
 * German question that is a line longer than the English one moves its wires
 * with it. The paths are lasting elements whose `d` is rewritten, so the
 * timeline's targets stay valid across a re-derivation.
 *
 * The arrival plays once, as the board comes into view: the question; the
 * three sources together, because Piloti consults them at the same time; the
 * wires merging into the decision; B chosen, and the wires that carry it
 * darken; B's wire down to the steps. The lime dot beside a stage's label is
 * where the chain is, and it waits there while the next stage is below the
 * fold. The pill holds it while it runs (WCAG 2.2.2) and replays it after.
 * Under reduced motion the wires are drawn and nothing moves.
 */

/** The sources whose findings carry the chosen way: the façade clause and the project's own section. */
const SUPPORTS_CHOICE = [0, 2]
/** Where the stem runs, inside the sources' left padding. */
const STEM_INSET = 16
/** How far B's wire runs out beside the decision before it turns down. */
const ELBOW = 10
/** How long each stage holds before the chain moves on, in seconds. */
const READ = [1.2, 1.0, 0.7, 0.9]

const SVG_NS = 'http://www.w3.org/2000/svg'

type Box = { x: number; y: number; w: number; h: number; cx: number; cy: number; right: number; bottom: number }

/**
 * An element's box in the stage's coordinates, from offsets rather than
 * `getBoundingClientRect`: the arrival moves cards by transform, and offsets
 * are the one measurement a transform does not change.
 */
const boxIn = (stage: HTMLElement, el: HTMLElement): Box => {
  let x = 0
  let y = 0
  for (let at: HTMLElement | null = el; at && at !== stage; at = at.offsetParent as HTMLElement | null) {
    x += at.offsetLeft
    y += at.offsetTop
  }
  const w = el.offsetWidth
  const h = el.offsetHeight
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, right: x + w, bottom: y + h }
}

/** A stagger in seconds, for GSAP (`staggerFor` counts in milliseconds). */
const stagger = (n: number, each?: number) => staggerFor(n, each) / 1000

export function initChain() {
  const board = document.querySelector<HTMLElement>('[data-chain-board]')
  const stage = board?.querySelector<HTMLElement>('[data-chain-stage]')
  const svg = board?.querySelector<SVGSVGElement>('[data-wires]')
  if (!board || !stage || !svg) return
  const one = (sel: string) => stage.querySelector<HTMLElement>(sel)
  const all = <T extends Element = HTMLElement>(sel: string) => Array.from(stage.querySelectorAll<T>(sel))

  const q = one('[data-node="q"]')
  const srcsNode = one('[data-node="srcs"]')
  const dec = one('[data-node="dec"]')
  const impl = one('[data-node="impl"]')
  if (!q || !srcsNode || !dec || !impl) return
  const rows = all('[data-row]').map((row) => ({
    row,
    chip: row.querySelector<HTMLElement>('[data-chip]')!,
    card: row.querySelector<HTMLElement>('[data-card]')!,
  }))
  const inPort = one('[data-port="in"]')
  const outPort = one('[data-port="out"]')

  // ── wires ─────────────────────────────────────────────────────────────────

  const kept = new Map<string, SVGElement>()
  const keep = <T extends SVGElement>(key: string, make: () => T): T => {
    const found = kept.get(key)
    if (found) return found as T
    const made = make()
    kept.set(key, made)
    svg.appendChild(made)
    return made
  }
  const css = getComputedStyle(document.documentElement)
  const PATH = css.getPropertyValue('--color-accent-900').trim() || '#2a301f'
  const FAINT = 'rgb(42 48 31 / 0.34)'
  const wire = (key: string, d: string, stroke = PATH, width = 1.5) => {
    const p = keep(key, () => {
      const el = document.createElementNS(SVG_NS, 'path')
      el.setAttribute('fill', 'none')
      el.setAttribute('stroke', stroke)
      el.setAttribute('stroke-width', String(width))
      el.setAttribute('stroke-linecap', 'round')
      return el
    })
    p.setAttribute('d', d)
    return p
  }
  const dot = (key: string, x: number, y: number) => {
    const c = keep(key, () => {
      const el = document.createElementNS(SVG_NS, 'circle')
      el.setAttribute('r', '3')
      el.setAttribute('fill', PATH)
      return el
    })
    c.setAttribute('cx', String(x))
    c.setAttribute('cy', String(y))
    return c
  }

  const draw = () => {
    const b = (el: HTMLElement) => boxIn(stage, el)
    const qb = b(q)
    const stemX = b(srcsNode).x + STEM_INSET
    const r = rows.map(({ chip, card }) => ({ chip: b(chip), card: b(card) }))
    const stem = wire('stem', `M${stemX},${qb.bottom} L${stemX},${r[r.length - 1].chip.cy}`)
    const stubs = r.flatMap(({ chip, card }, i) => {
      const out = [wire(`stub-in-${i}`, `M${stemX},${chip.cy} L${chip.x},${chip.cy}`)]
      // Wide, the card sits beside its chip and a second stub joins them;
      // narrow, it sits under it and needs none.
      if (card.x > chip.right + 2) out.push(wire(`stub-out-${i}`, `M${chip.right},${chip.cy} L${card.x},${chip.cy}`))
      return out
    })
    const dots = r.map(({ chip }, i) => dot(`dot-${i}`, stemX, chip.cy))

    const to = inPort ? b(inPort) : b(dec)
    const tx = b(dec).x
    const merge = ({ card }: (typeof r)[number]) => {
      const mid = (card.right + tx) / 2
      return `M${card.right},${card.cy} C${mid},${card.cy} ${mid},${to.cy} ${tx},${to.cy}`
    }
    const merges = r.map((row, i) => wire(`merge-${i}`, merge(row), FAINT))
    const chosen = SUPPORTS_CHOICE.map((i) => wire(`chosen-${i}`, merge(r[i]), PATH, 2))

    const d = b(dec)
    const i = b(impl)
    const y = outPort ? b(outPort).cy : d.cy
    const x = Math.min(d.right + ELBOW, i.right - 6)
    const turn = Math.max(0, Math.min(8, x - d.right))
    const toImpl = wire('to-impl', `M${d.right},${y} L${x - turn},${y} Q${x},${y} ${x},${y + turn} L${x},${i.y}`, PATH, 2)
    return { stem, stubs, dots, merges, chosen, toImpl }
  }

  // ── the arrival ───────────────────────────────────────────────────────────

  const here = all('[data-here]')
  const srcsMeta = srcsNode.querySelector<HTMLElement>('.meta')
  const cards = rows.map(({ row }) => row)
  const opts = all('[data-opt]')
  const field = all('[data-opt-field]')
  const ink = all<SVGPathElement>('[data-opt-ink]')
  const subs = all('[data-opt-sub]')
  const whys = all('[data-opt-why]')
  const steps = all('[data-step]')
  const checks = all<SVGPathElement>('[data-step-check]')
  const closing = all('[data-done]')
  const toggle = board.querySelector<HTMLButtonElement>('[data-chain-toggle]')
  const rise = () => ({ opacity: 1, y: 0 })

  gsap.matchMedia().add({ staged: MQ.staged, motion: MQ.motion }, (ctx) => {
    const { staged, motion } = ctx.conditions as { staged: boolean; motion: boolean }
    if (!staged) return
    const w = draw()
    const paths = [w.stem, ...w.stubs, ...w.merges, ...w.chosen, w.toImpl]

    // A board that changes size (a font landing, a resize, the other locale's
    // longer question) re-derives its wires. The first observation is the
    // one just drawn.
    let tl: gsap.core.Timeline | null = null
    let reset = () => {}
    const redraw = () => {
      draw()
      if (!tl) return
      // Rewind to the opening state, let every tween forget what it
      // measured, and seek back: each re-reads its line's new length.
      // Events are suppressed, so the seek neither fires the waits nor
      // re-announces a stage.
      const at = tl.progress()
      tl.progress(0, true)
      reset()
      tl.invalidate().progress(at, true)
    }
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(redraw)
    })
    ro.observe(stage)
    const unobserve = () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
    if (!motion) return unobserve

    // The opening state is set now, not when the timeline first plays: a
    // paused timeline renders nothing, so the finished board would stand
    // there until it scrolled into view and then snap back to the start.
    reset = () => {
      gsap.set([q, srcsMeta, ...cards, dec, impl, ...opts, ...steps, ...closing], { opacity: 0, y: TRAVEL.sm })
      gsap.set([...here, ...field, ...whys, ...w.dots], { opacity: 0 })
      gsap.set(subs, { opacity: 1 })
      gsap.set(paths, { drawSVG: 0 })
      gsap.set([...ink, ...checks], { strokeDashoffset: 1 })
    }
    reset()

    const seen = new Map<HTMLElement, boolean>()
    let waiting: HTMLElement | null = null
    /** Moves the lime dot on to stage `i`, once that stage is on screen. */
    const arrive = (i: number, node: HTMLElement, after: number) => {
      tl!.call(
        () => {
          if (seen.get(node)) return
          waiting = node
          tl!.pause()
        },
        [],
        `+=${after}`
      )
      tl!.to(here[i - 1], { opacity: 0, duration: sec('quick') }, '>').to(here[i], { opacity: 1, duration: sec('quick') }, '<')
    }

    tl = gsap.timeline({ paused: true, defaults: { duration: sec('slow'), ease: 'settle' }, onComplete: () => sync() })

    // 1 · the question
    tl.to(q, rise()).to(here[0], { opacity: 1, duration: sec('quick') }, '<')

    // 2 · the sources, all three at once: the stem, then every stub and card together.
    arrive(1, srcsNode, READ[0])
    tl.to(srcsMeta, rise(), '<')
      .to(w.stem, { drawSVG: '100%', duration: sec('base'), ease: 'draft' }, '<')
      .to(w.dots, { opacity: 1, duration: sec('quick') }, '>-0.1')
      .to(w.stubs, { drawSVG: '100%', duration: sec('quick'), ease: 'draft' }, '<')
      .to(cards, { ...rise(), stagger: stagger(cards.length) }, '<0.06')

    // 3 · the wires merge into the decision, which offers three ways.
    arrive(2, dec, READ[1])
    tl.to(w.merges, { drawSVG: '100%', ease: 'draft' }, '<')
      .to(dec, rise(), '<0.3')
      .to(opts, { ...rise(), stagger: stagger(opts.length) }, '<0.12')

    // B is chosen: ringed in lime, the wires that carry it darken, and each
    // way's description gives way to its reason.
    tl.to(field, { opacity: 1, duration: sec('base') }, `+=${READ[2]}`)
      .to(ink, { strokeDashoffset: 0, ease: 'draft' }, '<')
      .to(w.chosen, { drawSVG: '100%', ease: 'draft' }, '<')
      .to(subs, { opacity: 0, duration: sec('quick') }, '<0.24')
      .to(whys, { opacity: 1, duration: sec('base') }, '>')

    // 4 · B's wire runs down to the steps, which tick off one by one.
    arrive(3, impl, READ[3])
    tl.to(w.toImpl, { drawSVG: '100%', duration: sec('base'), ease: 'draft' }, '<')
      .to(impl, rise(), '>-0.1')
      .to(steps, { ...rise(), stagger: stagger(steps.length) }, '<0.12')
      .to(checks, { strokeDashoffset: 0, duration: sec('quick'), ease: 'draft', stagger: stagger(checks.length, STAGGER.max) }, '>-0.1')
      .to(closing, rise(), '>0.1')

    // Held by the reader, it stays held: scrolling away and back does not
    // resume what they stopped.
    let held = false
    let inView = false
    const sync = () => {
      if (!tl) return
      const finished = tl.progress() >= 1
      if (inView && !held && !finished && !waiting) tl.play()
      else tl.pause()
      if (!toggle) return
      const label = finished ? 'labelReplay' : held ? 'labelResume' : 'labelPause'
      toggle.textContent = toggle.dataset[label] ?? ''
      if (finished) toggle.removeAttribute('aria-pressed')
      else toggle.setAttribute('aria-pressed', String(held))
    }
    const triggers = [
      ScrollTrigger.create({
        trigger: board,
        start: 'top 75%',
        end: 'bottom 10%',
        onToggle: (self) => {
          inView = self.isActive
          sync()
        },
      }),
      ...[srcsNode, dec, impl].map((node) =>
        ScrollTrigger.create({
          trigger: node,
          start: 'top 90%',
          onEnter: () => {
            seen.set(node, true)
            if (waiting !== node) return
            waiting = null
            sync()
          },
        })
      ),
    ]
    const onToggle = () => {
      if (!tl) return
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
      unobserve()
      toggle?.removeEventListener('click', onToggle)
      if (toggle) toggle.hidden = true
      triggers.forEach((tr) => tr.kill())
      tl?.kill()
      tl = null
    }
  })
}
