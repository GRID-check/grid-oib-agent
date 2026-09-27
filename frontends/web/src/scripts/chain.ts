import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { TextPlugin } from 'gsap/TextPlugin'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { landingScript } from '../i18n/ui'
import { MQ, sec } from '../lib/motion'
import { gsap } from './motion-gsap'

gsap.registerPlugin(DrawSVGPlugin, TextPlugin, ScrollTrigger)

const L = document.documentElement.lang.startsWith('en') ? landingScript.en : landingScript.de

/**
 * The decision chain.
 *
 * Everything here that can be derived is derived. The previous version authored
 * every connector as literal SVG coordinates and drove them with a hand-rolled
 * player — a Catmull-Rom interpolator for the camera, a step-gating system in
 * CSS, a typing routine that sliced the string itself, and stroke-dasharray set
 * to a number larger than any line so the dash trick would work. Four separate
 * defects came out of that in one week, all of them the same defect: a
 * coordinate written down next to an element that later moved. A German
 * question is 21px taller than the English one, and no authored number is right
 * for both.
 *
 * So the diagram states where its *nodes* are, and this file works out
 * everything between them: wires are generated from the measured boxes, and
 * they start and end on ports — real elements inside the cards — so a wire
 * lands on the thing it means rather than on a number that used to be near it.
 * GSAP owns the rest: DrawSVGPlugin draws the wires, TextPlugin types the
 * question, ScrollTrigger decides when it runs, and a single timeline holds the
 * order that used to live in two parallel arrays of timestamps.
 */

/** The left margin the spine runs down, in the diagram's own coordinates. */
const SPINE_X = 14
/** Air between the question and the top of the chain. */
const STEM_GAP = 12

type Box = { x: number; y: number; w: number; h: number; cx: number; cy: number; right: number; bottom: number }

const box = (el: HTMLElement): Box => {
  // offsetLeft/offsetTop, not getBoundingClientRect: the camera scales this
  // subtree, and offsets are the one measurement a transform does not distort.
  const x = el.offsetLeft
  const y = el.offsetTop
  const w = el.offsetWidth
  const h = el.offsetHeight
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, right: x + w, bottom: y + h }
}

/** A port's box, in the coordinate space of the camera rather than its card. */
const portBox = (card: HTMLElement, cam: HTMLElement, selector: string): Box => {
  const port = card.querySelector<HTMLElement>(selector)
  if (!port) return box(card)
  let x = 0
  let y = 0
  for (let el: HTMLElement | null = port; el && el !== cam; el = el.offsetParent as HTMLElement | null) {
    x += el.offsetLeft
    y += el.offsetTop
  }
  const w = port.offsetWidth
  const h = port.offsetHeight
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, right: x + w, bottom: y + h }
}

/** The board only exists from lg up; below it the chain is the column list. */
const BOARD = MQ.staged
/** The smallest the camera may draw the board: below it the cards are unreadable. */
const MIN_SCALE = 0.85
/**
 * The sources whose findings carry the chosen way (B): the façade clause and
 * the project's own section. Their wires light up with the choice.
 */
const SUPPORTS_CHOICE = [0, 2]
/** How far the wire to the steps runs out beside the decision card before it turns down. */
const ELBOW = 20

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

function initChainBoard() {
  const anchor = document.querySelector<HTMLElement>('[data-chat-anchor]')
  const stage = anchor?.querySelector<HTMLElement>('[data-stage]')
  const cam = anchor?.querySelector<HTMLElement>('[data-cam]')
  const wires = anchor?.querySelector<SVGSVGElement>('[data-wires]')
  const qText = anchor?.querySelector<HTMLElement>('[data-q-text]')
  const caret = anchor?.querySelector<HTMLElement>('[data-q-caret]')
  const status = anchor?.querySelector<HTMLElement>('[data-status]')
  const replay = anchor?.querySelector<HTMLButtonElement>('[data-replay]')
  const pause = anchor?.querySelector<HTMLButtonElement>('[data-chain-pause]')
  const live = anchor?.querySelector<HTMLElement>('[data-chain-live]')
  if (!anchor || !stage || !cam || !wires || !qText || !status) return

  const node = (name: string) => Array.from(cam.querySelectorAll<HTMLElement>(`[data-node="${name}"]`))
  const part = (name: string, which: string) =>
    cam.querySelector<HTMLElement>(`[data-node="${name}"][data-part="${which}"]`)
  const sources = ['s1', 's2', 's3']
  const scan = cam.querySelector<HTMLElement>('[data-scan]')
  const options = ['a', 'b', 'c'].map((k) => cam.querySelector<HTMLElement>(`[data-opt="${k}"]`))
  // Optional nodes are addressed as (possibly empty) lists, so a missing one is
  // simply nothing to animate rather than a tween against null.
  const caretT = caret ? [caret] : []
  const optT = (i: number) => (options[i] ? [options[i]!] : [])
  const subs = Array.from(cam.querySelectorAll<HTMLElement>('[data-opt-sub]'))
  const whys = Array.from(cam.querySelectorAll<HTMLElement>('[data-opt-why]'))
  const mark = Array.from(cam.querySelectorAll<HTMLElement>('[data-opt-mark]'))
  const tick = Array.from(cam.querySelectorAll<SVGPathElement>('[data-opt-tick]'))

  // ── geometry ──────────────────────────────────────────────────────────────

  const SVG_NS = 'http://www.w3.org/2000/svg'

  /*
   * A wire is a lasting element whose geometry is re-derived — not a fresh
   * element per measurement.
   *
   * `draw()` runs again on every ScrollTrigger refresh and once more when the
   * fonts land. Replacing the paths there would break the animation twice over:
   * the timeline was built against the old elements and would go on animating
   * them after they were detached (`invalidate()` re-reads values, it does not
   * re-target), and the replacements, never having been set to `drawSVG: 0`,
   * would stand fully drawn from the moment they appeared. Keeping the elements
   * and moving them keeps every target valid, and `invalidate()` then does the
   * one job it is good at: re-reading the new lengths.
   */
  const kept = new Map<string, SVGElement>()
  const keep = <T extends SVGElement>(key: string, make: () => T): T => {
    const found = kept.get(key)
    if (found) return found as T
    const made = make()
    kept.set(key, made)
    wires.appendChild(made)
    return made
  }

  // The chosen way is drawn in the same green as B's mark, from the sources
  // that carry it, through B, on to the steps.
  const ok = getComputedStyle(document.documentElement).getPropertyValue('--color-ok').trim() || '#0f7a3d'
  const wire = (key: string, d: string, kind: string, stroke = '#26272a') => {
    const path = keep(key, () => {
      const p = document.createElementNS(SVG_NS, 'path')
      p.setAttribute('fill', 'none')
      p.setAttribute('stroke', stroke)
      p.setAttribute('stroke-width', '1.6')
      p.setAttribute('stroke-linecap', 'round')
      p.dataset.wire = kind
      return p
    })
    path.setAttribute('d', d)
    return path
  }
  const dot = (key: string, x: number, y: number) => {
    const c = keep(key, () => {
      const el = document.createElementNS(SVG_NS, 'circle')
      el.setAttribute('r', '3')
      el.setAttribute('fill', '#26272a')
      el.dataset.wire = 'dot'
      return el
    })
    c.setAttribute('cx', String(x))
    c.setAttribute('cy', String(y))
    return c
  }

  type Wires = {
    stem: SVGPathElement
    stops: number[]
    rows: { stub: SVGPathElement[]; dots: SVGCircleElement[] }[]
    merges: SVGPathElement[]
    chosen: SVGPathElement[]
    toImpl: SVGPathElement | null
  }

  const draw = (): Wires => {
    // The question is typed in, so it is measured holding all of its text —
    // otherwise a rebuild that lands mid-typing pins the chain to a card that is
    // about to grow.
    const shown = qText.textContent
    qText.textContent = L.question
    const q = box(node('q')[0])
    qText.textContent = shown

    const rows = sources.map((name) => ({ chip: part(name, 'chip')!, card: part(name, 'card')! }))
    const headY = q.bottom + STEM_GAP
    const lastY = box(rows[rows.length - 1].chip).cy
    const stem = wire('stem', `M${SPINE_X},${headY} L${SPINE_X},${lastY}`, 'stem')

    // How far down the spine each row sits, as a fraction of its length. The
    // spine reaches a row when that row arrives and no further, so it is not
    // running past sources the chain has not consulted yet.
    const span = lastY - headY || 1
    const stops = rows.map(({ chip }) => Math.min(100, ((box(chip).cy - headY) / span) * 100))

    const rowWires = rows.map(({ chip, card }, i) => {
      const c = box(chip)
      const k = box(card)
      return {
        stub: [
          wire(`stub-${i}-in`, `M${SPINE_X},${c.cy} L${c.x},${c.cy}`, 'stub'),
          wire(`stub-${i}-out`, `M${c.right},${c.cy} L${k.x},${c.cy}`, 'stub'),
        ],
        dots: [dot(`dot-${i}-in`, SPINE_X, c.cy), dot(`dot-${i}-out`, c.right, c.cy)],
      }
    })

    // The merge curves land on the decision card's own header, and the wire on
    // to the implementation leaves from the option that was chosen — both are
    // elements, so neither can drift away from what it points at.
    const dec = node('dec')[0]
    const inPort = dec ? portBox(dec, cam, '[data-port="in"]') : null
    const mergePath = (card: HTMLElement, to: Box) => {
      const k = box(card)
      const midX = (k.right + to.x) / 2
      return `M${k.right},${k.cy} C${midX},${k.cy} ${midX},${to.cy} ${to.x},${to.cy}`
    }
    const merges = inPort ? rows.map(({ card }, i) => wire(`merge-${i}`, mergePath(card, inPort), 'merge')) : []
    // The same curves again, in green, laid over the ones that carry the choice.
    const chosen = inPort
      ? SUPPORTS_CHOICE.map((i) => wire(`chosen-${i}`, mergePath(rows[i].card, inPort), 'chosen', ok))
      : []

    // The wire on to the steps leaves the decision card's edge level with B,
    // runs out beside it and turns down onto the steps: from any frame it
    // starts at the option it continues, not somewhere under option C.
    const impl = node('impl')[0]
    const outPort = dec ? portBox(dec, cam, '[data-port="out"]') : null
    let toImpl: SVGPathElement | null = null
    if (dec && impl && outPort) {
      const d = box(dec)
      const i = box(impl)
      const x = Math.min(d.right + ELBOW, i.right - 24)
      const r = Math.max(0, Math.min(10, x - d.right))
      const y = outPort.cy
      toImpl = wire('to-impl', `M${d.right},${y} L${x - r},${y} Q${x},${y} ${x},${y + r} L${x},${i.y}`, 'impl', ok)
    }

    if (scan) scan.style.top = `${q.bottom + STEM_GAP}px`
    return { stem, stops, rows: rowWires, merges, chosen, toImpl }
  }

  // ── camera ────────────────────────────────────────────────────────────────

  /*
   * Where a framed node may sit in the stage. The stage's edges dissolve over
   * 30px (`.stage-mask`) and the status line covers the bottom, so the inset
   * clears both: a node the camera stops on is never faded or cut at its edge.
   * It used to be 12–24px, inside the fade, and stops sliced their cards.
   */
  const INSET = { top: 32, right: 32, bottom: 56, left: 32 }
  const MARGIN = 12

  const fit = (els: HTMLElement[], vw: number, vh: number) => {
    const b = els.map(box)
    const x0 = Math.min(...b.map((v) => v.x)) - MARGIN
    const y0 = Math.min(...b.map((v) => v.y)) - MARGIN
    const x1 = Math.max(...b.map((v) => v.right)) + MARGIN
    const y1 = Math.max(...b.map((v) => v.bottom)) + MARGIN
    const scale = Math.min(1, (vw - INSET.left - INSET.right) / (x1 - x0), (vh - INSET.top - INSET.bottom) / (y1 - y0))
    return { x0, y0, x1, y1, scale }
  }

  /**
   * Fit the named nodes whole in the frame, and never magnify past the true
   * size. Below 0.85 the cards' text is unreadable, so a set of nodes that
   * does not fit at that size is neither squeezed nor cropped: the camera
   * frames the last of them, the one the chain has just reached, on its own.
   * Only the closing overview ('all') goes smaller: it is a picture of the
   * whole chain, not something to read.
   */
  const frame = (names: string[]) => {
    const r = stage.getBoundingClientRect()
    const vw = r.width || 700
    const vh = r.height || 430
    const all = names.includes('all')
    const group = (list: string[]) =>
      list.flatMap((n) => (n === 'all' ? Array.from(cam.querySelectorAll<HTMLElement>('[data-node]')) : node(n)))

    let els = group(names)
    if (!els.length) return { x: 0, y: 0, scale: 1 }
    let f = fit(els, vw, vh)
    if (!all && f.scale < MIN_SCALE && names.length > 1) {
      els = group(names.slice(-1))
      f = fit(els, vw, vh)
    }
    const scale = all ? f.scale : Math.max(MIN_SCALE, f.scale)
    const cx = (f.x0 + f.x1) / 2 - (INSET.left - INSET.right) / 2 / scale
    const cy = (f.y0 + f.y1) / 2 - (INSET.top - INSET.bottom) / 2 / scale
    return { x: vw / 2 - cx * scale, y: vh / 2 - cy * scale, scale }
  }

  // ── the timeline ──────────────────────────────────────────────────────────

  const say = (i: number) => () => {
    if (status.textContent !== L.beats[i]) status.textContent = L.beats[i]
  }
  /** A tween that moves the camera onto the named nodes. */
  const camTo = (names: string[], duration = sec('slow')) =>
    gsap.to(cam, { ...frame(names), duration, ease: 'draft' })

  const mm = gsap.matchMedia()

  mm.add(`${BOARD} and (prefers-reduced-motion: no-preference)`, () => {
    const w = draw()
    const cards = sources.flatMap((n) => node(n)).concat(node('dec'), node('impl'))
    // Strokes and dots are set up differently: a dot is a filled circle with no
    // stroke, so `drawSVG` has nothing to shorten and would leave all six
    // junctions standing there from the first frame, ahead of the rows they
    // belong to. They are hidden outright and brought in with their row instead.
    const strokes = () => Array.from(wires.querySelectorAll<SVGPathElement>('path'))
    const dots = () => Array.from(wires.querySelectorAll<SVGCircleElement>('[data-wire="dot"]'))

    // Once, ending on the finished chain. It used to loop forever, which is
    // motion a reader cannot stop (WCAG 2.2.2) and a decision that never
    // stays decided; the replay button starts it again.
    const tl = gsap.timeline({
      paused: true,
      defaults: { ease: 'settle' },
      onComplete: () => setRunning(false),
    })

    // The opening state is applied now, not when the timeline first plays.
    // A paused timeline renders nothing, so what stood on the page until the
    // chain scrolled into view was the finished diagram — every card, every
    // wire, the question already typed — which then snapped back to the start
    // to derive an answer the reader had been looking at the whole time.
    const reset = () => {
      gsap.set(cards, { autoAlpha: 0, y: 8 })
      gsap.set(scan, { autoAlpha: 0 })
      gsap.set(strokes(), { autoAlpha: 1, drawSVG: 0 })
      gsap.set(dots(), { autoAlpha: 0 })
      gsap.set(qText, { text: '' })
      gsap.set(caretT, { display: 'inline-block' })
      gsap.set(cam, frame(['q', 's1']))
      gsap.set(subs, { autoAlpha: 1 })
      gsap.set([...whys, ...mark], { autoAlpha: 0 })
      gsap.set(tick, { drawSVG: 0 })
      status.textContent = L.typing
      options.forEach((o) => o?.classList.remove('opt--receded', 'opt--chosen'))
    }
    reset()
    tl.call(reset)

    tl.to(qText, { duration: 0.7, ease: 'none', text: { value: L.question, delimiter: '' } })
      .set(caretT, { display: 'none' })
      .call(say(0))
      .to(scan, { autoAlpha: 1, duration: 0.3 }, '-=0.1')
      .call(say(1))

    sources.forEach((name, i) => {
      const at = i === 0 ? '+=0.35' : '+=0.2'
      tl.to(scan, { autoAlpha: 0, duration: 0.2 }, at)
        .to(w.stem, { drawSVG: `0% ${w.stops[i]}%`, duration: 0.7 }, '<')
        .to(w.rows[i].stub, { drawSVG: '100%', duration: 0.35, stagger: 0.12 }, '<0.15')
        .to(w.rows[i].dots, { autoAlpha: 1, duration: 0.2 }, '<')
        .to([part(name, 'chip'), part(name, 'card')], { autoAlpha: 1, y: 0, duration: 0.4, stagger: 0.08 }, '<0.1')
        .call(say(i + 2))
        // The question stays in the shot while the sources gather under it.
        .add(camTo(['q', ...sources.slice(0, i + 1)]), '<')
    })

    // The merge wires set off towards the decision and the camera goes with
    // them, straight to the card. It used to stop half-way, on the sources and
    // the decision together, which no stage fits at a readable size: both
    // ends of that shot were cut.
    tl.call(say(5), [], '+=0.3')
      .to(w.merges, { drawSVG: '100%', duration: 0.5, ease: 'draft', stagger: 0.14 }, '+=0.3')
      .call(say(6), [], '<')
      .add(camTo(['dec']), '<')
      .to(node('dec'), { autoAlpha: 1, y: 0, duration: 0.5 }, '-=0.3')
      .call(say(7))

    // The way is chosen: B takes its mark and the green of the wires that
    // carry it; the others recede to the muted ink (not to a transparency,
    // which took their text below 4.5:1). Each way's second line then gives
    // its reason, the same reasons the phone stories give.
    tl.call(say(8), [], '+=0.9')
      .call(
        () => {
          ;[...optT(0), ...optT(2)].forEach((o) => o.classList.add('opt--receded'))
          optT(1).forEach((o) => o.classList.add('opt--chosen'))
        },
        [],
        '<'
      )
      .to(optT(1), { backgroundColor: '#eef6ee', borderLeftColor: ok, duration: sec('base') }, '<')
      .to(w.chosen, { drawSVG: '100%', duration: 0.5, ease: 'draft', stagger: 0.1 }, '<')
      .to(mark, { autoAlpha: 1, duration: sec('base') }, '<')
      .to(tick, { drawSVG: '100%', duration: sec('base'), ease: 'draft' }, '<0.1')
      .to(subs, { autoAlpha: 0, duration: sec('quick') }, '<')
      .to(whys, { autoAlpha: 1, duration: sec('base') }, '>')

    // B's wire runs on out of the card, and the camera follows it down.
    if (w.toImpl) {
      tl.to(w.toImpl, { drawSVG: '100%', duration: 0.7, ease: 'draft' }, '+=1')
        .add(camTo(['impl']), '<0.2')
        .to(node('impl'), { autoAlpha: 1, y: 0, duration: 0.5 }, '-=0.2')
        .call(say(9))
    }

    tl.call(say(10), [], '+=1').add(camTo(['all'], sec('slow')), '<')

    // Held by the reader, it stays held: scrolling away and back does not
    // resume what they stopped.
    let held = false
    let inView = false
    const setRunning = (on: boolean) => {
      if (live) live.style.animationPlayState = on ? 'running' : 'paused'
      if (pause) {
        pause.hidden = tl.progress() >= 1
        pause.setAttribute('aria-pressed', String(held))
        pause.textContent = (held ? pause.dataset.labelResume : pause.dataset.labelPause) ?? ''
      }
    }
    const sync = () => {
      const run = inView && !held && tl.progress() < 1
      if (run) tl.play()
      else tl.pause()
      setRunning(run)
    }
    ScrollTrigger.create({
      trigger: anchor,
      start: 'top 85%',
      end: 'bottom 15%',
      onToggle: (self) => {
        inView = self.isActive
        sync()
      },
    })

    const onReplay = () => {
      held = false
      tl.restart()
      sync()
    }
    const onPause = () => {
      held = !held
      sync()
    }
    replay?.addEventListener('click', onReplay)
    pause?.addEventListener('click', onPause)

    // The mock's size decides both the wires and the framing, so a resize
    // re-derives them; ScrollTrigger already debounces that for us.
    const rebuild = () => {
      draw()
      // The paths are the same elements, so this is all `invalidate` has to do:
      // forget the lengths it recorded and measure the moved lines again.
      tl.invalidate()
    }
    ScrollTrigger.addEventListener('refresh', rebuild)
    document.fonts?.ready.then(rebuild)

    return () => {
      replay?.removeEventListener('click', onReplay)
      pause?.removeEventListener('click', onPause)
      ScrollTrigger.removeEventListener('refresh', rebuild)
      tl.kill()
    }
  })
  // Without motion there is no board at all: ChatMock shows the column list
  // in its place (`motion-reduce:`), which is the finished chain at full size.
}
