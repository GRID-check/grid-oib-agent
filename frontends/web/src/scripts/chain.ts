import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { landingScript } from '../i18n/ui'
import { MQ, sec, STAGGER, staggerFor, TRAVEL } from '../lib/motion'
import { gsap } from './motion-gsap'

gsap.registerPlugin(DrawSVGPlugin, ScrollTrigger)

const L = document.documentElement.lang.startsWith('en') ? landingScript.en : landingScript.de

/**
 * The decision chain.
 *
 * The desktop board (ChatMock) is the chain as linked nodes, laid out by CSS to
 * fit its card: the question, three sources, the decision (a check table of
 * every way against every source) and the steps. Its markup is the finished
 * chain. This file adds what CSS cannot: the wires, and one play of the chain
 * as it comes into view.
 *
 * The wires are derived, never authored. An earlier board wrote its connectors
 * as literal coordinates, and every defect it had was the same one: a number
 * written down next to an element that later moved (a German question is a
 * line taller than the English one). So the nodes state where they are, and
 * each wire runs between ports measured on them: the question's foot, a
 * source's head and foot, the top of its column in the table, the chosen
 * way's row, the steps' header.
 *
 * The play, once, pausable, replayable:
 *   1. the question arrives and fans out to the sources;
 *   2. each source is wired into its column of the decision;
 *   3. the check, source by source: the source, its wire and its column light
 *      together and that column's marks are drawn;
 *   4. the verdict: the ways not chosen recede with their reasons, the chosen
 *      one is tinted with its own, and its wire carries on to the steps.
 *
 * It replaced a camera panning over a 1160px diagram inside the card, which
 * cropped the cards mid-move and showed the choice only as two options fading.
 */

/** The board only exists from lg up; below it the chain is told as stories. */
const BOARD = MQ.staged

export function initChain() {
  initChainBoard()
  initChainList()
}

/**
 * The phone column: the finished chain is in the markup, so without motion (or
 * without JS) there is nothing to do. With motion, the four steps arrive in
 * order as the list comes into view and the spine grows down to meet each one
 * — once, and never tied to the scroll position.
 */
function initChainList() {
  const list = document.querySelector<HTMLElement>('[data-chain-list]')
  if (!list) return
  const steps = Array.from(list.querySelectorAll<HTMLElement>('[data-chain-step]'))
  const spine = list.querySelector<HTMLElement>('[data-chain-spine]')

  gsap.matchMedia().add(`(max-width: 1023.98px) and (prefers-reduced-motion: no-preference)`, () => {
    if (list.getBoundingClientRect().top < window.innerHeight * 0.8) return
    gsap.set(steps, { autoAlpha: 0, y: 14 })
    if (spine) gsap.set(spine, { scaleY: 0 })
    const tl = gsap.timeline({
      defaults: { ease: 'power2.out' },
      scrollTrigger: { trigger: list, start: 'top 75%', once: true },
    })
    steps.forEach((step, i) => {
      tl.to(step, { autoAlpha: 1, y: 0, duration: 0.5 }, i * 0.55)
      if (spine) tl.to(spine, { scaleY: (i + 1) / steps.length, duration: 0.5, ease: 'none' }, i * 0.55)
    })
  })
}

// ── geometry ──────────────────────────────────────────────────────────────

type Box = { x: number; y: number; w: number; h: number; cx: number; cy: number; right: number; bottom: number }

/**
 * An element's box in `root`'s coordinates, summed from offsets: a transform
 * (a node arriving 8px low, the section's reveal) does not distort them, so a
 * wire measured mid-arrival still lands where the node comes to rest.
 */
const boxIn = (el: HTMLElement, root: HTMLElement): Box => {
  let x = 0
  let y = 0
  for (let e: HTMLElement | null = el; e && e !== root; e = e.offsetParent as HTMLElement | null) {
    x += e.offsetLeft
    y += e.offsetTop
  }
  const w = el.offsetWidth
  const h = el.offsetHeight
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, right: x + w, bottom: y + h }
}

/**
 * Down from one port to a lane, along it, and down into the next port: a
 * drawing's orthogonal leader, with its corners eased. Wires that share a gap
 * each take their own lane, so none crosses another.
 */
const route = (x0: number, y0: number, lane: number, x1: number, y1: number) => {
  const dx = x1 - x0
  if (Math.abs(dx) < 1) return `M${x0},${y0} V${y1}`
  const s = Math.sign(dx)
  const r = Math.max(0, Math.min(6, Math.abs(dx) / 2, lane - y0, y1 - lane))
  return `M${x0},${y0} V${lane - r} Q${x0},${lane} ${x0 + s * r},${lane} H${x1 - s * r} Q${x1},${lane} ${x1},${lane + r} V${y1}`
}

/** Out of a card's left edge, down the gutter, into the next card's left edge. */
const elbow = (x0: number, y0: number, gx: number, x1: number, y1: number) => {
  const r = Math.min(8, (y1 - y0) / 2, (x0 - gx) / 2)
  return `M${x0},${y0} H${gx + r} Q${gx},${y0} ${gx},${y0 + r} V${y1 - r} Q${gx},${y1} ${gx + r},${y1} H${x1}`
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const INK = 'rgb(27 28 25 / 0.42)'
const LIT = '#5c6b42' // --color-accent-600: a source in use
const OK = '#0f7a3d' // --color-ok: the way chosen, carried on

function initChainBoard() {
  const board = document.querySelector<HTMLElement>('[data-chat-anchor]')
  const net = board?.querySelector<HTMLElement>('[data-net]')
  const svg = board?.querySelector<SVGSVGElement>('[data-wires]')
  const status = board?.querySelector<HTMLElement>('[data-status]')
  const q = board?.querySelector<HTMLElement>('[data-node="q"]')
  const dec = board?.querySelector<HTMLElement>('[data-node="dec"]')
  const impl = board?.querySelector<HTMLElement>('[data-node="impl"]')
  const matrix = board?.querySelector<HTMLElement>('[data-matrix]')
  const colLit = board?.querySelector<HTMLElement>('[data-col-lit]')
  if (!board || !net || !svg || !status || !q || !dec || !impl || !matrix || !colLit) return
  const pause = board.querySelector<HTMLButtonElement>('[data-chain-pause]')
  const replay = board.querySelector<HTMLButtonElement>('[data-replay]')

  const all = <T extends Element = HTMLElement>(sel: string, root: ParentNode = board) =>
    Array.from(root.querySelectorAll<T>(sel))
  const srcs = all('[data-node="src"]')
  const srcLit = srcs.map((s) => s.querySelector<HTMLElement>('[data-lit]')).filter((s): s is HTMLElement => !!s)
  const heads = all('[data-col]')
  const opts = all('[data-opt]')
  // The verdict is read from the markup, which holds the finished chain: the
  // script never decides which way was chosen, it only withholds it.
  const verdicts = opts.map((o) => (o.classList.contains('is-chosen') ? 'is-chosen' : 'is-receded'))
  const chosen = opts.filter((_, r) => verdicts[r] === 'is-chosen')
  const receded = opts.filter((_, r) => verdicts[r] === 'is-receded')
  const pickRow = chosen[0]?.querySelector<HTMLElement>('tr')
  const whyOf = (os: HTMLElement[]) => os.flatMap((o) => all('[data-why]', o))
  const picks = all('[data-pick]')
  const marks = opts.map((o) => all<SVGSVGElement>('[data-mark]', o))
  const markEls = marks.flat()
  const column = (c: number) => marks.map((row) => row[c]).filter(Boolean)
  const strokes = (els: SVGSVGElement[]) =>
    els.flatMap((el) => Array.from(el.querySelectorAll<SVGGeometryElement>('path, circle')))
  const implRows = all('[data-impl]', impl)
  const implHead = impl.firstElementChild as HTMLElement | null

  // ── wires ───────────────────────────────────────────────────────────────

  /*
   * A wire is a lasting element whose geometry is re-derived, not a fresh
   * element per measurement: the timeline holds these elements, so replacing
   * them on a resize would leave it animating detached paths.
   */
  const make = <T extends SVGElement>(tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS(SVG_NS, tag) as T
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    svg.appendChild(el)
    return el
  }
  const path = (stroke: string, width: number) =>
    make<SVGPathElement>('path', {
      fill: 'none',
      stroke,
      'stroke-width': String(width),
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    })
  const dot = (fill: string) => make<SVGCircleElement>('circle', { r: '2.75', fill })
  const at = (c: SVGCircleElement, x: number, y: number) => {
    c.setAttribute('cx', String(x))
    c.setAttribute('cy', String(y))
  }

  // Question → each source; each source → its column (and a lit copy of that
  // wire for the check); the chosen way → the steps.
  const ask = srcs.map(() => path(INK, 1.25))
  const feed = srcs.map(() => path(INK, 1.25))
  const lit = srcs.map(() => path(LIT, 2))
  const carry = path(OK, 1.5)
  const qDot = dot(INK)
  const inDots = srcs.map(() => dot(INK))
  const outDots = srcs.map(() => dot(INK))
  const colDots = srcs.map(() => dot(INK))
  const carryDots = [dot(OK), dot(OK)]
  // At rest the lit copies are hidden: the finished chain shows no check in
  // progress.
  gsap.set(lit, { autoAlpha: 0 })

  const place = () => {
    const qb = boxIn(q, net)
    const d = boxIn(dec, net)
    at(qDot, qb.cx, qb.bottom)
    const n = srcs.length
    srcs.forEach((s, i) => {
      const b = boxIn(s, net)
      // The question's wires share one trunk and one bus, halfway down.
      ask[i].setAttribute('d', route(qb.cx, qb.bottom, (qb.bottom + b.y) / 2, b.cx, b.y))
      at(inDots[i], b.cx, b.y)
      at(outDots[i], b.cx, b.bottom)
      const head = heads[i] ? boxIn(heads[i], net) : null
      if (!head) return
      // Each source runs right to its column in a lane of its own: the first
      // source, which travels furthest, lowest, so it passes under the others'
      // drops instead of through them.
      const gap = d.y - b.bottom
      const lane = b.bottom + gap * (0.3 + (0.4 * (n - 1 - i)) / Math.max(1, n - 1))
      const wire = route(b.cx, b.bottom, lane, head.cx, d.y)
      feed[i].setAttribute('d', wire)
      lit[i].setAttribute('d', wire)
      at(colDots[i], head.cx, d.y)
    })
    const i = boxIn(impl, net)
    const iy = implHead ? i.y + implHead.offsetHeight / 2 : i.y + 18
    const by = pickRow ? boxIn(pickRow, net).y + 18 : d.cy
    // The gutter the carry wire runs down: halfway between the net's edge and
    // the cards'.
    const gx = d.x / 2
    carry.setAttribute('d', elbow(d.x, by, gx, i.x, iy))
    at(carryDots[0], d.x, by)
    at(carryDots[1], i.x, iy)

    // The column highlight: one header cell wide, from the table's head to
    // its foot, moved from column to column by `xPercent` (the columns are
    // equal and adjacent). Placed here, never animated in size.
    const table = matrix.querySelector('table')
    if (heads[0] && table) {
      const h = boxIn(heads[0], matrix)
      Object.assign(colLit.style, {
        left: `${h.x}px`,
        top: `${h.y}px`,
        width: `${h.w}px`,
        height: `${table.offsetHeight - h.y}px`,
      })
    }
    onPlace?.()
  }
  let onPlace: (() => void) | undefined

  const say = (text: string) => {
    if (status.textContent !== text) status.textContent = text
  }
  const beat = (i: number) => () => say(L.beats[i])
  const finish = () => {
    opts.forEach((o, r) => {
      o.classList.remove('is-chosen', 'is-receded')
      o.classList.add(verdicts[r])
    })
    say(L.beats[L.beats.length - 1])
  }

  const mm = gsap.matchMedia()

  // The wires, with or without motion: they are part of the finished chain.
  mm.add(BOARD, () => {
    place()
    const ro = new ResizeObserver(() => place())
    ro.observe(net)
    document.fonts?.ready.then(place)
    return () => ro.disconnect()
  })

  mm.add(`${BOARD} and ${MQ.motion}`, () => {
    const wires = [...ask, ...feed, ...lit, carry]
    const dots = [qDot, ...inDots, ...outDots, ...colDots, ...carryDots]

    const reset = () => {
      gsap.set([q, ...srcs, dec, impl, ...implRows], { autoAlpha: 0, y: TRAVEL.sm })
      gsap.set(wires, { autoAlpha: 1, drawSVG: 0 })
      gsap.set([...dots, ...srcLit, colLit], { autoAlpha: 0 })
      gsap.set(colLit, { xPercent: 0 })
      // A round cap on a stroke of length 0 still paints a dot, so a mark is
      // hidden outright as well as undrawn, and shown as its stroke starts.
      gsap.set(markEls, { autoAlpha: 0 })
      gsap.set(strokes(markEls), { drawSVG: 0 })
      gsap.set([...whyOf(opts), ...picks], { autoAlpha: 0 })
      opts.forEach((o) => o.classList.remove('is-chosen', 'is-receded'))
      say('')
    }

    const tl = gsap.timeline({
      paused: true,
      defaults: { ease: 'settle', duration: sec('slow') },
      onComplete: () => sync(),
    })
    const row = STAGGER.row / 1000
    const draw = { drawSVG: '100%', duration: sec('slow'), ease: 'draft' }

    // 1. The question, fanning out to the sources.
    tl.to(q, { autoAlpha: 1, y: 0 })
      .call(beat(0), [], '<')
      .set(qDot, { autoAlpha: 1 }, '+=0.1')
      .to(ask, { ...draw, stagger: row }, '<')
      .set(inDots, { autoAlpha: 1 }, `-=${sec('quick')}`)
      .to(srcs, { autoAlpha: 1, y: 0, stagger: row }, '<')
      .call(beat(1), [], '<')

    // 2. Each source wired into its column of the decision.
    tl.set(outDots, { autoAlpha: 1 }, '+=0.3')
      .to(feed, { ...draw, stagger: row }, '<')
      .set(colDots, { autoAlpha: 1 }, `-=${sec('quick')}`)
      .to(dec, { autoAlpha: 1, y: 0 }, '<')
      .call(beat(2), [], '<')

    // 3. The check, source by source: the source, its wire and its column
    //    light together, so each mark is seen to rest on what it cites.
    heads.forEach((_, c) => {
      const lead = c === 0 ? '+=0.4' : '+=0.55'
      tl.to(srcLit[c] ?? [], { autoAlpha: 1, duration: sec('base') }, lead)
        .to(lit[c], { ...draw, duration: sec('base') }, '<')
        .to([srcLit[c - 1] ?? [], lit[c - 1] ?? []].flat(), { autoAlpha: 0, duration: sec('base') }, '<')
      if (c === 0) tl.to(colLit, { autoAlpha: 1, duration: sec('base') }, `<${sec('quick')}`)
      else tl.to(colLit, { xPercent: c * 100, duration: sec('base'), ease: 'draft' }, `<${sec('quick')}`)
      tl.call(beat(3 + c), [], '<')
      column(c).forEach((m, r) => {
        tl.set(m, { autoAlpha: 1 }, r === 0 ? `<${sec('quick')}` : `<${row}`).to(
          strokes([m]),
          { drawSVG: '100%', duration: sec('base'), ease: 'draft' },
          '<'
        )
      })
    })
    tl.to([colLit, ...srcLit, ...lit], { autoAlpha: 0, duration: sec('base') }, '+=0.6')

    // 4. The verdict, and the chosen way carried on to the steps.
    tl.call(() => receded.forEach((o) => o.classList.add('is-receded')), [], '<')
      .to(whyOf(receded), { autoAlpha: 1, stagger: staggerFor(receded.length, STAGGER.max) / 1000 }, '<')
      .call(() => chosen.forEach((o) => o.classList.add('is-chosen')), [], '+=0.35')
      .to([...picks, ...whyOf(chosen)], { autoAlpha: 1, duration: sec('base') }, '<')
      .call(beat(6), [], '<')
      .set(carryDots[0], { autoAlpha: 1 }, '+=0.35')
      .to(carry, draw, '<')
      .set(carryDots[1], { autoAlpha: 1 }, `-=${sec('quick')}`)
      .to(impl, { autoAlpha: 1, y: 0 }, '<')
      .to(implRows, { autoAlpha: 1, y: 0, stagger: row }, `<${sec('quick')}`)
      .call(beat(7), [], '<')
      .call(finish, [], '+=0.7')

    // Held by the reader, it stays held: scrolling away and back does not
    // resume what they stopped.
    let held = false
    let inView = false
    const sync = () => {
      const done = tl.progress() >= 1
      if (inView && !held && !done) tl.play()
      else tl.pause()
      const hadFocus = document.activeElement === pause
      if (pause) {
        pause.hidden = done
        pause.setAttribute('aria-pressed', String(held))
        pause.textContent = (held ? pause.dataset.labelResume : pause.dataset.labelPause) ?? ''
      }
      if (replay) replay.hidden = !done
      if (done && hadFocus) replay?.focus()
    }

    // A resize moves the ports. A drawn wire's dash was measured on its old
    // length, so: before the play, undraw it again at the new length; after,
    // drop the dash; during, let the timeline re-measure.
    onPlace = () => {
      if (tl.isActive()) tl.invalidate()
      else if (tl.progress() === 0) gsap.set(wires, { drawSVG: 0 })
      else gsap.set(wires, { clearProps: 'strokeDasharray,strokeDashoffset' })
    }

    // Anything already on screen at load is not hidden and replayed: the
    // chain stands finished, with its replay.
    if (board.getBoundingClientRect().top < window.innerHeight * 0.6) tl.progress(1)
    else reset()

    // It starts once the board's top has crossed 60% of the screen, not as it
    // peeks in: the board is most of a screen tall, and the check (the part
    // worth seeing) comes three seconds in, in its lower half.
    ScrollTrigger.create({
      trigger: board,
      start: 'top 40%',
      end: 'bottom 20%',
      onToggle: (self) => {
        inView = self.isActive
        sync()
      },
    })

    const onReplay = () => {
      held = false
      reset()
      // Re-record every start value from the reset state: a chain that stood
      // finished at load recorded its tweens' starts as their ends.
      tl.invalidate().restart()
      sync()
      pause?.focus()
    }
    const onPause = () => {
      held = !held
      sync()
    }
    replay?.addEventListener('click', onReplay)
    pause?.addEventListener('click', onPause)
    sync()

    return () => {
      onPlace = undefined
      replay?.removeEventListener('click', onReplay)
      pause?.removeEventListener('click', onPause)
      tl.kill()
      finish()
      if (pause) pause.hidden = true
      if (replay) replay.hidden = true
    }
  })
}
