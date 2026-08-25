import { gsap } from 'gsap'
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { TextPlugin } from 'gsap/TextPlugin'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { landingScript } from '../i18n/ui'

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

export function initChain() {
  const anchor = document.querySelector<HTMLElement>('[data-chat-anchor]')
  const stage = anchor?.querySelector<HTMLElement>('[data-stage]')
  const cam = anchor?.querySelector<HTMLElement>('[data-cam]')
  const wires = anchor?.querySelector<SVGSVGElement>('[data-wires]')
  const qText = anchor?.querySelector<HTMLElement>('[data-q-text]')
  const caret = anchor?.querySelector<HTMLElement>('[data-q-caret]')
  const status = anchor?.querySelector<HTMLElement>('[data-status]')
  const replay = anchor?.querySelector<HTMLButtonElement>('[data-replay]')
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

  const wire = (key: string, d: string, kind: string) => {
    const path = keep(key, () => {
      const p = document.createElementNS(SVG_NS, 'path')
      p.setAttribute('fill', 'none')
      p.setAttribute('stroke', '#26272a')
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

  type Wires = { stem: SVGPathElement; rows: { stub: SVGPathElement[]; dots: SVGCircleElement[] }[]; merges: SVGPathElement[]; toImpl: SVGPathElement | null }

  const draw = (): Wires => {
    // The question is typed in, so it is measured holding all of its text —
    // otherwise a rebuild that lands mid-typing pins the chain to a card that is
    // about to grow.
    const shown = qText.textContent
    qText.textContent = L.question
    const q = box(node('q')[0])
    qText.textContent = shown

    const rows = sources.map((name) => ({ chip: part(name, 'chip')!, card: part(name, 'card')! }))
    const lastY = box(rows[rows.length - 1].chip).cy
    const stem = wire('stem', `M${SPINE_X},${q.bottom + STEM_GAP} L${SPINE_X},${lastY}`, 'stem')

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
    const merges = inPort
      ? rows.map(({ card }, i) => {
          const k = box(card)
          const midX = (k.right + inPort.x) / 2
          return wire(
            `merge-${i}`,
            `M${k.right},${k.cy} C${midX},${k.cy} ${midX},${inPort.cy} ${inPort.x},${inPort.cy}`,
            'merge'
          )
        })
      : []

    const impl = node('impl')[0]
    const outPort = dec ? portBox(dec, cam, '[data-port="out"]') : null
    let toImpl: SVGPathElement | null = null
    if (impl && outPort) {
      const i = box(impl)
      const midY = (outPort.bottom + i.y) / 2
      toImpl = wire(
        'to-impl',
        `M${outPort.cx},${outPort.bottom} C${outPort.cx},${midY} ${i.cx},${midY} ${i.cx},${i.y}`,
        'impl'
      )
    }

    if (scan) scan.style.top = `${q.bottom + STEM_GAP}px`
    return { stem, rows: rowWires, merges, toImpl }
  }

  // ── camera ────────────────────────────────────────────────────────────────

  const INSET = { top: 22, right: 24, bottom: 48, left: 24 }
  const TIGHT = { top: 14, right: 12, bottom: 40, left: 12 }

  /** Fit the named nodes in the frame, and never magnify past the true size. */
  const frame = (names: string[]) => {
    const r = stage.getBoundingClientRect()
    const vw = r.width || 700
    const vh = r.height || 430
    const narrow = vw < 560
    const inset = narrow ? TIGHT : INSET
    const margin = narrow ? 8 : 14

    let els = names.flatMap((n) => (n === 'all' ? Array.from(cam.querySelectorAll<HTMLElement>('[data-node]')) : node(n)))
    if (narrow && els.length > 1) {
      els = [els.reduce((a, b) => (a.offsetWidth * a.offsetHeight >= b.offsetWidth * b.offsetHeight ? a : b))]
    }
    if (!els.length) return { x: 0, y: 0, scale: 1 }

    const b = els.map(box)
    const x0 = Math.min(...b.map((v) => v.x)) - margin
    const y0 = Math.min(...b.map((v) => v.y)) - margin
    const x1 = Math.max(...b.map((v) => v.right)) + margin
    const y1 = Math.max(...b.map((v) => v.bottom)) + margin

    const scale = Math.min(1, (vw - inset.left - inset.right) / (x1 - x0), (vh - inset.top - inset.bottom) / (y1 - y0))
    const cx = (x0 + x1) / 2 - (inset.left - inset.right) / 2 / scale
    const cy = (y0 + y1) / 2 - (inset.top - inset.bottom) / 2 / scale
    return { x: vw / 2 - cx * scale, y: vh / 2 - cy * scale, scale }
  }

  // ── the timeline ──────────────────────────────────────────────────────────

  const say = (i: number) => () => {
    if (status.textContent !== L.beats[i]) status.textContent = L.beats[i]
  }
  /** A tween that moves the camera onto the named nodes. */
  const camTo = (names: string[], duration = 1) =>
    gsap.to(cam, { ...frame(names), duration, ease: 'power2.inOut' })

  const mm = gsap.matchMedia()

  mm.add('(prefers-reduced-motion: no-preference)', () => {
    const w = draw()
    const cards = sources.flatMap((n) => node(n)).concat(node('dec'), node('impl'))
    const allWires = () => Array.from(wires.children) as SVGElement[]

    const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.6, paused: true, defaults: { ease: 'power2.out' } })

    tl.set(cards, { autoAlpha: 0, y: 8 })
      .set(scan, { autoAlpha: 0 })
      .set(allWires(), { autoAlpha: 1, drawSVG: 0 })
      .set(qText, { text: '' })
      .set(caretT, { display: 'inline-block' })
      .set(cam, frame(['q', 's1']))
      .call(() => { status.textContent = L.typing })

    tl.to(qText, { duration: 1.5, ease: 'none', text: { value: L.question, delimiter: '' } })
      .set(caretT, { display: 'none' })
      .call(say(0))
      .to(scan, { autoAlpha: 1, duration: 0.3 }, '-=0.1')
      .call(say(1))

    sources.forEach((name, i) => {
      const at = i === 0 ? '+=0.35' : '+=0.2'
      tl.to(scan, { autoAlpha: 0, duration: 0.2 }, at)
        .to(w.stem, { drawSVG: '100%', duration: 0.7 }, i === 0 ? '<' : '<')
        .to(w.rows[i].stub, { drawSVG: '100%', duration: 0.35, stagger: 0.12 }, '<0.15')
        .to(w.rows[i].dots, { autoAlpha: 1, duration: 0.2 }, '<')
        .to([part(name, 'chip'), part(name, 'card')], { autoAlpha: 1, y: 0, duration: 0.4, stagger: 0.08 }, '<0.1')
        .call(say(i + 2))
        .add(camTo(i === 0 ? ['q', 's1'] : sources.slice(0, i + 1)), '<')
    })

    tl.call(say(5), [], '+=0.3')
      .add(camTo(sources), '<')
      .to(w.merges, { drawSVG: '100%', duration: 0.8, stagger: 0.14 }, '+=0.1')
      .call(say(6), [], '<')
      .add(camTo([...sources, 'dec'], 1.1), '<')
      .to(node('dec'), { autoAlpha: 1, y: 0, duration: 0.5 }, '-=0.3')
      .call(say(7))
      .add(camTo(['dec']), '<')

    // The option is chosen: the others recede rather than disappear.
    tl.to([...optT(0), ...optT(2)], { opacity: 0.32, duration: 0.5 }, '+=0.5')
      .to(optT(1), { backgroundColor: '#eef6ee', borderLeftColor: '#17914d', duration: 0.5 }, '<')
      .call(say(8), [], '<')

    if (w.toImpl) {
      tl.to(w.toImpl, { drawSVG: '100%', duration: 0.7 }, '+=0.35')
        .add(camTo(['dec', 'impl'], 1.1), '<')
        .to(node('impl'), { autoAlpha: 1, y: 0, duration: 0.5 }, '-=0.2')
        .call(say(9))
        .add(camTo(['impl']), '<')
    }

    tl.call(say(10), [], '+=0.6').add(camTo(['all'], 1.3), '<')

    ScrollTrigger.create({
      trigger: anchor,
      start: 'top 85%',
      end: 'bottom 15%',
      onToggle: (self) => (self.isActive ? tl.play() : tl.pause()),
    })

    const onReplay = () => tl.restart()
    replay?.addEventListener('click', onReplay)

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
      ScrollTrigger.removeEventListener('refresh', rebuild)
      tl.kill()
    }
  })

  // Without motion the chain is simply the finished diagram, drawn and still.
  mm.add('(prefers-reduced-motion: reduce)', () => {
    draw()
    qText.textContent = L.question
    gsap.set(caretT, { display: 'none' })
    gsap.set(Array.from(wires.children), { autoAlpha: 1, drawSVG: '100%' })
    gsap.set(cam, frame(['all']))
    gsap.set([...optT(0), ...optT(2)], { opacity: 0.32 })
    gsap.set(optT(1), { backgroundColor: '#eef6ee', borderLeftColor: '#17914d' })
    status.textContent = L.beats[10]
    if (replay) replay.hidden = true
  })
}
