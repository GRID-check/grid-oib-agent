import { gsap } from 'gsap'
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { landingScript } from '../i18n/ui'

gsap.registerPlugin(DrawSVGPlugin, ScrollTrigger)
import { initReveals } from './reveal'
import { initChain } from './chain'
import { initRoi } from './roi'
import { initSheetIndex } from './sheet-index'

const L = document.documentElement.lang.startsWith('en') ? landingScript.en : landingScript.de


const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

function initHeroCta() {
  const cta = document.querySelector<HTMLElement>('[data-hero-cta]')
  if (!cta) return
  const wrap = document.querySelector<HTMLElement>('[data-hero-wrap]')
  // Without motion the hero is a single screen and the closing line simply
  // stays put: the yield below is scrubbed against scroll position, which is
  // the kind of scroll-linked movement `prefers-reduced-motion` asks us to drop.
  if (reduced) return
  if (wrap) wrap.style.height = '200vh'
  // The closing line and its buttons yield as soon as the page starts moving —
  // scrubbed, so it tracks the scroll rather than snapping at a threshold.
  gsap.to(cta, {
    opacity: 0,
    y: -10,
    ease: 'none',
    scrollTrigger: {
      trigger: wrap ?? cta,
      start: 'top top',
      end: () => `+=${window.innerHeight * 0.12}`,
      scrub: true,
      onUpdate: (self) => {
        cta.style.pointerEvents = self.progress > 0.6 ? 'none' : 'auto'
      },
    },
  })
}

function initAura() {
  const cv = document.querySelector<HTMLCanvasElement>('[data-aura]')
  if (!cv || reduced) return
  const ctx = cv.getContext('2d')
  if (!ctx) return
  let w = 0
  let h = 0
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const IW = 1376
  const IH = 768
  const HEAD: [number, number] = [700, 196]
  /** How far out of the halo a line has to start before it is drawn at all. */
  const BEAM_START = 0.2
  let sc = 1
  let ox = 0
  let oy = 0
  const resize = () => {
    const r = cv.getBoundingClientRect()
    w = r.width || cv.offsetWidth
    h = r.height || cv.offsetHeight
    if (!w || !h) return false
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    sc = Math.max(w / IW, h / IH)
    ox = (w - IW * sc) / 2
    oy = (h - IH * sc) / 2
    return true
  }
  resize()
  window.addEventListener('resize', resize)
  const P = (ix: number, iy: number): [number, number] => [ox + ix * sc, oy + iy * sc]

  const NODES = [
    { r: 96, a: 0.4, v: 0.045 },
    { r: 138, a: 2.1, v: -0.032 },
    { r: 118, a: 3.6, v: 0.052 },
    { r: 176, a: 5.0, v: -0.026 },
    { r: 150, a: 1.2, v: 0.038 },
    { r: 208, a: 4.1, v: 0.021 },
    { r: 104, a: 5.6, v: -0.058 },
    { r: 190, a: 2.7, v: -0.019 },
    { r: 232, a: 0.9, v: 0.016 },
    { r: 128, a: 4.6, v: 0.029 },
    { r: 214, a: 3.2, v: 0.024 },
    { r: 166, a: 6.0, v: -0.036 },
  ].map((n, i) => ({ ...n, label: L.aura[i] }))
  const BEAMS: [number, number][] = [
    [600, 330],
    [792, 318],
    [648, 424],
    [742, 400],
    [700, 372],
  ]

  const draw = (t: number) => {
    if (!cv.isConnected) return
    if (cv.width !== Math.round(cv.getBoundingClientRect().width * dpr)) {
      if (!resize()) return
    }
    if (!w || !h) return

    ctx.clearRect(0, 0, w, h)
    const [hx, hy] = P(HEAD[0], HEAD[1])
    const ts = t / 1000
    const TOP = 74
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, TOP, w, Math.max(0, h - TOP))
    ctx.clip()

    const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, 250 * sc)
    const pulse = 0.1 + 0.03 * Math.sin(ts * 0.7)
    halo.addColorStop(0, `rgba(120,140,88,${pulse.toFixed(3)})`)
    halo.addColorStop(1, 'rgba(120,140,88,0)')
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(hx, hy, 250 * sc, 0, Math.PI * 2)
    ctx.fill()

    ctx.lineWidth = 1
    // Two rings, not three, and drawn faint: the aura is instrumentation over a
    // photograph, and instrumentation that shouts stops looking like precision.
    const rings: [number, number, number][] = [
      [116, 0.05, 0.13],
      [206, -0.03, 0.085],
    ]
    rings.forEach(([r, spd, al], i) => {
      ctx.save()
      ctx.translate(hx, hy)
      ctx.rotate(ts * spd + i)
      ctx.strokeStyle = `rgba(94,110,70,${al})`
      ctx.setLineDash([13 * sc, 11 * sc])
      ctx.beginPath()
      ctx.arc(0, 0, r * sc, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    })
    ctx.setLineDash([])

    ctx.font = `${(9.5 * Math.max(1, sc * 0.75)).toFixed(1)}px 'IBM Plex Mono', monospace`
    ctx.letterSpacing = '0.08em'
    NODES.forEach((n, i) => {
      const ang = n.a + ts * n.v
      const nx = hx + Math.cos(ang) * n.r * sc
      const ny = hy + Math.sin(ang) * n.r * sc * 0.86
      const glow = 0.5 + 0.5 * Math.sin(ts * 1.1 + i)
      // A leader line is drawn to the nodes that say something, and only
      // suggested for the rest, so the eye follows the labels.
      const named = Boolean(n.label)
      // The line gathers as it travels out — but it also has to START further
      // out. A gradient that begins at zero still converges on the same pixel as
      // the other eleven, and twelve nearly-invisible strokes stacked on one
      // point add up to a visible one: the fan was tied in a knot at her head.
      // So each ray begins clear of the halo and there is nothing at the centre
      // to accumulate.
      const START = BEAM_START
      const sx = hx + (nx - hx) * START
      const sy = hy + (ny - hy) * START
      const a = (named ? 0.1 : 0.05) + (named ? 0.09 : 0.04) * glow
      const ray = ctx.createLinearGradient(sx, sy, nx, ny)
      ray.addColorStop(0, 'rgba(94,110,70,0)')
      ray.addColorStop(0.5, `rgba(94,110,70,${(a * 0.4).toFixed(3)})`)
      ray.addColorStop(1, `rgba(94,110,70,${a.toFixed(3)})`)
      ctx.strokeStyle = ray
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(nx, ny)
      ctx.stroke()
      // The node sits ON the photograph rather than in it: a soft drop shadow
      // is what gives a 2px dot enough presence to survive a busy background.
      ctx.save()
      ctx.shadowColor = 'rgba(34,39,26,0.45)'
      ctx.shadowBlur = 5 * Math.max(1, sc * 0.8)
      ctx.shadowOffsetY = 1
      ctx.fillStyle = `rgba(88,104,64,${((named ? 0.4 : 0.22) + 0.35 * glow).toFixed(3)})`
      ctx.beginPath()
      ctx.arc(nx, ny, (named ? 1.7 : 1.1 + 0.6 * glow) * Math.max(1, sc * 0.8), 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      // A label belongs to its node, so it takes whichever side of the node has
      // room for it. Written blindly to the right, the ones on a phone ran off
      // the canvas and were read as a column of broken words down the edge.
      const EDGE = 12
      if (n.label && nx > EDGE && nx < w - EDGE) {
        const lines = Array.isArray(n.label) ? n.label : [n.label]
        const lh = 11.5 * Math.max(1, sc * 0.75)
        const textW = Math.max(...lines.map((ln) => ctx.measureText(ln).width))
        const right = nx + 7 * sc
        const flip = right + textW > w - EDGE && nx - 7 * sc - textW > EDGE
        ctx.textAlign = flip ? 'right' : 'left'
        const lx = flip ? nx - 7 * sc : Math.min(right, Math.max(EDGE, w - EDGE - textW))
        // A halo in the paper's own colour, not a shadow: the labels cross hair,
        // sleeve and drawing in one pass, and this is what keeps 9px mono legible
        // over all three without putting a box behind it.
        ctx.save()
        ctx.shadowColor = 'rgba(247,247,243,0.95)'
        ctx.shadowBlur = 7 * Math.max(1, sc * 0.7)
        lines.forEach((ln, li) => {
          ctx.fillStyle = `rgba(78,92,56,${((li === 0 ? 0.44 : 0.3) + 0.3 * glow).toFixed(3)})`
          ctx.fillText(ln, lx, ny - 5 * sc + li * lh)
          ctx.fillText(ln, lx, ny - 5 * sc + li * lh)
        })
        ctx.restore()
        ctx.textAlign = 'left'
      }
    })

    BEAMS.forEach((b, i) => {
      const [bx, by] = P(b[0], b[1])
      const cyc = (ts * 0.42 + i / BEAMS.length) % 1
      const grow = Math.min(1, cyc / 0.55)
      const fade = cyc > 0.78 ? 1 - (cyc - 0.78) / 0.22 : 1
      if (fade <= 0) return
      // These are the ones that were tying the knot: five beams drawn from the
      // exact centre at 0.28 alpha, stacked on the same pixel. They leave from
      // the same clear radius the leader lines do, and fade in over it.
      const bsx = hx + (bx - hx) * BEAM_START
      const bsy = hy + (by - hy) * BEAM_START
      const ex = hx + (bx - hx) * Math.max(BEAM_START, grow)
      const ey = hy + (by - hy) * Math.max(BEAM_START, grow)
      const beam = ctx.createLinearGradient(bsx, bsy, ex, ey)
      beam.addColorStop(0, 'rgba(94,110,70,0)')
      beam.addColorStop(1, `rgba(94,110,70,${(0.3 * fade).toFixed(3)})`)
      ctx.strokeStyle = beam
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(bsx, bsy)
      ctx.lineTo(ex, ey)
      ctx.stroke()
      if (grow >= 1) {
        ctx.save()
        ctx.shadowColor = 'rgba(34,39,26,0.4)'
        ctx.shadowBlur = 6 * Math.max(1, sc * 0.8)
        ctx.fillStyle = `rgba(88,104,64,${(0.6 * fade).toFixed(3)})`
        ctx.beginPath()
        ctx.arc(bx, by, 2.4 * Math.max(1, sc * 0.8), 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
        ctx.strokeStyle = `rgba(94,110,70,${(0.42 * fade).toFixed(3)})`
        ctx.beginPath()
        ctx.arc(bx, by, (5 + 7 * (1 - fade)) * Math.max(1, sc * 0.8), 0, Math.PI * 2)
        ctx.stroke()
      }
    })

    ctx.globalCompositeOperation = 'destination-out'
    const fadeTop = ctx.createLinearGradient(0, TOP, 0, TOP + 16)
    fadeTop.addColorStop(0, 'rgba(0,0,0,1)')
    fadeTop.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = fadeTop
    ctx.fillRect(0, TOP, w, 16)
    ctx.globalCompositeOperation = 'source-over'
    ctx.restore()
  }

  // GSAP's ticker is the render loop: one rAF for the whole page, and the
  // browser parks it with the tab, so the canvas costs nothing off-screen
  // without a visibilitychange handler of its own.
  const tick = () => draw(performance.now())
  ScrollTrigger.create({
    trigger: cv,
    start: 'top bottom',
    end: 'bottom top',
    onToggle: (self) => (self.isActive ? gsap.ticker.add(tick) : gsap.ticker.remove(tick)),
  })
}

interface Frag {
  el: HTMLElement
  /** Entrance offset, in the direction the fragment drifts in from. */
  dx: number
  dy: number
  /** Authored direction away from the hub, as an angle in radians. */
  ang: number
  /** Measured size and resting (CSS) centre inside the panel. */
  w: number
  h: number
  hx: number
  hy: number
  /** Scattered beat: where the fragment lies before it is organised. */
  sx: number
  sy: number
  rot: number
  /** Solved slot: translation from the resting centre, and whether it fits. */
  tx: number
  ty: number
  fits: boolean
}

/** Deterministic 0..1 noise — the scatter must survive a resize unchanged. */
const noise = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453
  return s - Math.floor(s)
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const overlaps = (a: Rect, b: Rect, gap = 0) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w + gap * 2 &&
  Math.abs(a.y - b.y) * 2 < a.h + b.h + gap * 2

/**
 * Places the knowledge fragments around the hub card.
 *
 * The arrangement is solved from measurements rather than chosen by a
 * breakpoint: each fragment keeps its authored *direction* from the hub, and
 * the radius along that direction is whatever the panel actually affords once
 * the hub card, the headline and the panel edges are accounted for.
 *
 * A narrow or portrait panel cannot hold a ring — the fragments are wider than
 * the space beside the hub — so it falls back to a `net`: the same fragments
 * spread as a jittered constellation below the hub. Both arrangements are wired
 * to the hub by the same connecting lines, because that is the point being
 * made; only the shape of the net changes with the space available.
 */
function solveStoryLayout(
  frags: Frag[],
  panel: Rect,
  hub: Rect,
  headline: Rect,
  gridHub: Rect
) {
  const PAD = 20
  const GAP = 18

  const ring = frags.map((f) => {
    const ux = Math.cos(f.ang)
    const uy = Math.sin(f.ang)
    // Furthest the fragment can travel along its direction and stay inside.
    const limit = (u: number, half: number, from: number, extent: number) =>
      u === 0
        ? Infinity
        : u > 0
          ? (extent - PAD - half - from) / u
          : (PAD + half - from) / u
    const rMax = Math.min(
      limit(ux, f.w / 2, hub.x, panel.w),
      limit(uy, f.h / 2, hub.y, panel.h)
    )
    // Nearest it may sit without touching the hub card.
    const clear = (u: number, span: number) => (u === 0 ? Infinity : span / Math.abs(u))
    const rMin = Math.min(
      clear(ux, (hub.w + f.w) / 2 + GAP),
      clear(uy, (hub.h + f.h) / 2 + GAP)
    )
    return { f, ux, uy, rMin, rMax }
  })

  const slots = ring.map(({ f, ux, uy, rMin, rMax }) => {
    // Walk inward from the outermost radius until the fragment clears the
    // headline too; the headline sits above the hub, so the fragments that
    // travel upwards are the ones that have to give way.
    for (let s = 0; s <= 6; s++) {
      const r = rMax - ((rMax - rMin) * s) / 6
      if (r < rMin - 0.5) break
      const rect = { x: hub.x + ux * r, y: hub.y + uy * r, w: f.w, h: f.h }
      if (!overlaps(rect, headline, 12)) return { f, rect, ok: rMax >= rMin }
    }
    return { f, rect: { x: hub.x + ux * rMax, y: hub.y + uy * rMax, w: f.w, h: f.h }, ok: false }
  })

  const fits =
    slots.every((s) => s.ok) &&
    slots.every((a, i) => slots.every((b, j) => i >= j || !overlaps(a.rect, b.rect, 10)))

  if (fits) {
    slots.forEach(({ f, rect }, i) => {
      f.tx = rect.x - f.hx
      f.ty = rect.y - f.hy
      // The authored CSS positions are already the scattered beat here.
      f.sx = 0
      f.sy = 0
      f.rot = (noise(i + 1) - 0.5) * 7
      f.fits = true
    })
    return 'ring' as const
  }

  // Portrait net. Columns give the constellation its underlying order (nothing
  // overlaps, nothing is cropped) and a deterministic jitter within each cell
  // takes the table-like regularity back out, so the lines to the hub still
  // read as a net rather than a bill of materials.
  const COL = 26
  const MIN_COL = 150
  const JITTER_X = 10
  const JITTER_Y = 9
  const bandTop = gridHub.y + gridHub.h / 2 + GAP
  const bandBottom = panel.h - PAD
  const bandW = panel.w - PAD * 2
  const cols = Math.max(1, Math.min(4, Math.floor((bandW + COL) / (MIN_COL + COL))))
  const colW = (bandW - (cols - 1) * COL) / cols
  const track = colW + COL
  // A fragment wider than one column spans several rather than being squashed
  // into one — the info cards are single-line rows and would wrap and clip.
  const spanOf = (f: Frag) => Math.max(1, Math.min(cols, Math.ceil((f.w + COL) / track)))
  const widthOf = (span: number) => span * colW + (span - 1) * COL

  const placed = frags.map((f) => ({ f, span: spanOf(f) }))
  placed.forEach(({ f, span }) => {
    f.el.style.width = `${Math.max(f.w, widthOf(span))}px`
  })
  placed.forEach(({ f, span }) => {
    f.w = Math.max(f.w, widthOf(span))
    f.h = f.el.offsetHeight
    f.hx = f.el.offsetLeft + f.w / 2
    f.hy = f.el.offsetTop + f.h / 2
  })

  const rows: { cards: typeof placed; span: number }[] = []
  let row: typeof placed = []
  let used = 0
  for (const item of placed) {
    if (used && used + item.span > cols) {
      rows.push({ cards: row, span: used })
      row = []
      used = 0
    }
    row.push(item)
    used += item.span
  }
  if (row.length) rows.push({ cards: row, span: used })

  const rowH = rows.map((r) => Math.max(...r.cards.map(({ f }) => f.h)))
  const overflowAt = rowH.findIndex(
    (_, i) => bandTop + rowH.slice(0, i + 1).reduce((a, b) => a + b, 0) + i * COL > bandBottom
  )
  const shown = overflowAt === -1 ? rows.length : overflowAt
  const totalH = rowH.slice(0, shown).reduce((a, b) => a + b, 0) + Math.max(0, shown - 1) * COL

  let top = bandTop + Math.max(0, (bandBottom - bandTop - totalH) / 2)
  let seed = 0
  rows.forEach(({ cards, span }, ri) => {
    let x = (panel.w - widthOf(span)) / 2
    cards.forEach(({ f, span: s }) => {
      seed += 1
      const jx = (noise(seed) - 0.5) * 2 * JITTER_X
      const jy = (noise(seed + 91) - 0.5) * 2 * JITTER_Y
      f.tx = x + f.w / 2 + jx - f.hx
      f.ty = top + rowH[ri] / 2 + jy - f.hy
      // Scattered beat: adrift across the same area — but kept inside the
      // panel, since a fragment sliced off by the panel edge reads as a bug
      // rather than as disorder.
      const within = (v: number, half: number, lo: number, hi: number) =>
        Math.min(Math.max(v, lo + half), Math.max(lo + half, hi - half))
      f.sx =
        within(
          f.hx + f.tx + (noise(seed + 17) - 0.5) * panel.w * 0.5,
          f.w / 2,
          PAD,
          panel.w - PAD
        ) - f.hx
      f.sy =
        within(
          f.hy + f.ty + (noise(seed + 43) - 0.5) * (bandBottom - bandTop) * 0.55,
          f.h / 2,
          bandTop - (bandBottom - bandTop) * 0.15,
          bandBottom
        ) - f.hy
      f.rot = (noise(seed + 5) - 0.5) * 14
      f.fits = ri < shown
      x += widthOf(s) + COL
    })
    if (ri < shown) top += rowH[ri] + COL
  })
  return 'net' as const
}

function initPins() {
  const wrap = document.querySelector<HTMLElement>('[data-pin="story"]')
  const sticky = wrap?.querySelector<HTMLElement>('[data-pin-sticky]')
  const panel = wrap?.querySelector<HTMLElement>('[data-story-panel]')
  const nav = document.querySelector<HTMLElement>('[data-nav]')
  if (!wrap || !sticky || !panel) return

  const hProblem = wrap.querySelector<HTMLElement>('[data-h-problem]')
  const hSolution = wrap.querySelector<HTMLElement>('[data-h-solution]')
  const solutionCard = wrap.querySelector<HTMLElement>('[data-solution-card]')
  const linksSvg = wrap.querySelector<SVGSVGElement>('[data-links]')

  // Authored fractions describe the composition on a landscape panel; only the
  // direction they imply is kept, and the solver decides the distance.
  const DESIGN_W = 16
  const DESIGN_H = 9

  const fragEls: Frag[] = Array.from(wrap.querySelectorAll<HTMLElement>('[data-frag]')).map(
    (el) => {
      const [dx, dy] = (el.getAttribute('data-frag') ?? '0,0').split(',').map(Number)
      const [fx, fy] = (el.getAttribute('data-target') ?? '0.5,0.5').split(',').map(Number)
      el.style.willChange = 'transform, opacity'
      el.style.opacity = '0'
      const ang = Math.atan2((fy - 0.57) * DESIGN_H, (fx - 0.5) * DESIGN_W)
      return {
        el, dx, dy, ang,
        w: 0, h: 0, hx: 0, hy: 0,
        sx: 0, sy: 0, rot: 0,
        tx: 0, ty: 0, fits: true,
      }
    }
  )

  let lineEls: SVGLineElement[] | null = null
  let mode: 'ring' | 'net' = 'ring'

  const measureStory = () => {
    const W = panel.clientWidth
    const H = panel.clientHeight
    if (!W || !H) return

    const cardW = solutionCard?.offsetWidth ?? 0
    const cardH = solutionCard?.offsetHeight ?? 0
    const hlW = hSolution?.offsetWidth ?? 0
    const hlH = hSolution?.offsetHeight ?? 0
    // A ring keeps the hub optically centred inside the fan; a portrait net
    // stacks headline → hub → fragments, so both move up to make room.
    const HUB_Y = { ring: 0.57, net: 0.4 }
    const HEAD_Y = { ring: 0.21, net: 0.11 }
    const hubAt = (f: number) => ({ x: 0.5 * W, y: f * H, w: cardW, h: cardH })
    const headAt = (f: number) => ({ x: 0.5 * W, y: f * H + hlH / 2, w: hlW, h: hlH })

    // Back to intrinsic size before measuring — grid mode stretches the
    // fragments to a shared column width, which would otherwise be measured as
    // if it were their natural width on the next pass.
    fragEls.forEach((f) => {
      f.el.style.display = ''
      f.el.style.width = ''
    })
    fragEls.forEach((f) => {
      f.w = f.el.offsetWidth
      f.h = f.el.offsetHeight
      f.hx = f.el.offsetLeft + f.w / 2
      f.hy = f.el.offsetTop + f.h / 2
    })

    mode = solveStoryLayout(
      fragEls,
      { x: 0, y: 0, w: W, h: H },
      hubAt(HUB_Y.ring),
      headAt(HEAD_Y.ring),
      hubAt(HUB_Y.net)
    )
    const hub = hubAt(HUB_Y[mode])
    if (solutionCard) solutionCard.style.top = `${HUB_Y[mode] * 100}%`
    if (hSolution) hSolution.style.top = `${HEAD_Y[mode] * 100}%`
    fragEls.forEach((f) => {
      if (!f.fits) f.el.style.display = 'none'
    })

    if (linksSvg && !lineEls) {
      const NS = 'http://www.w3.org/2000/svg'
      lineEls = fragEls.map(() => {
        const l = document.createElementNS(NS, 'line')
        l.setAttribute('stroke', '#a4b47a')
        l.setAttribute('stroke-width', '1.5')
        linksSvg.appendChild(l)
        return l
      })
    }
    if (linksSvg) linksSvg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    lineEls?.forEach((l, i) => {
      const f = fragEls[i]
      // Fragments that were left out get a zero-length line, which draws nothing.
      const x = f.fits ? f.hx + f.tx : hub.x
      const y = f.fits ? f.hy + f.ty : hub.y
      l.setAttribute('x1', String(hub.x))
      l.setAttribute('y1', String(hub.y))
      l.setAttribute('x2', String(x))
      l.setAttribute('y2', String(y))
    })
  }

  /**
   * The story, as one scrubbed timeline.
   *
   * This used to be a scroll handler that recomputed every fragment's transform
   * on each frame: two easing windows per card worked out by hand, a transform
   * string assembled with template literals, and the connecting lines drawn by
   * setting strokeDashoffset against a length measured earlier. The arithmetic
   * was correct and completely opaque — the choreography lived in expressions
   * like `0.03 + (i / n) * 0.27` and could only be read by simulating it.
   *
   * A timeline says the same thing as a score: this fragment drifts in here, the
   * net pulls it into place there. GSAP owns the interpolation, DrawSVGPlugin
   * owns the lines, and ScrollTrigger owns the scrubbing, so the only thing
   * still written here is the order of events.
   */
  const setNavHidden = (hide: boolean) => {
    if (!nav || hide === navHidden) return
    navHidden = hide
    gsap.to(nav, { y: hide ? '-110%' : '0%', opacity: hide ? 0 : 1, duration: 0.5, ease: 'power2.out' })
    nav.toggleAttribute('inert', hide)
    if (hide) nav.setAttribute('aria-hidden', 'true')
    else nav.removeAttribute('aria-hidden')
  }
  let navHidden = false

  /**
   * @param runway Whether the wrapper carries the scroll distance the scrubbed
   * timeline plays across. Without motion there is no scrubbing, so the section
   * is one screen: nobody should have to scroll four of them past a still image.
   */
  const sizePins = (runway = true) => {
    sticky.style.position = 'sticky'
    sticky.style.top = '0'
    sticky.style.boxSizing = 'border-box'
    sticky.style.height = 'auto'
    sticky.style.overflow = 'visible'
    if (sticky.scrollHeight <= window.innerHeight) {
      sticky.style.height = '100vh'
      sticky.style.overflow = 'hidden'
    }
    measureStory()
    // The scroll runway is the beat list's length: the ring adds the fan-out
    // and the connecting lines, the grid does not, so it needs less scrolling.
    wrap.style.height = runway ? (mode === 'ring' ? '440vh' : '300vh') : ''
  }

  const mm = gsap.matchMedia()

  mm.add('(prefers-reduced-motion: reduce)', () => {
    sizePins(false)
    fragEls.forEach((f) => gsap.set(f.el, { opacity: 1, x: f.tx, y: f.ty, rotation: 0, scale: 0.84 }))
    if (lineEls) gsap.set(lineEls, { opacity: 0.45, drawSVG: '100%' })
    gsap.set([hProblem].filter(Boolean), { opacity: 0 })
    gsap.set([hSolution].filter(Boolean), { opacity: 1, xPercent: -50, y: 0 })
    gsap.set([solutionCard].filter(Boolean), { opacity: 1, xPercent: -50, yPercent: -50, scale: 1 })
  })

  mm.add('(prefers-reduced-motion: no-preference)', () => {
    let ctx: gsap.Context | null = null

    const build = () => {
      ctx?.revert()
      ctx = gsap.context(() => {
        sizePins()
        const n = fragEls.length || 1
        const tl = gsap.timeline({
          defaults: { ease: 'power2.out' },
          scrollTrigger: {
            trigger: wrap,
            start: 'top top',
            end: 'bottom bottom',
            scrub: 0.4,
            onToggle: (self) => setNavHidden(self.isActive),
          },
        })

        fragEls.forEach((f, i) => {
          if (!f.fits) return
          // Drift in from where it was scattered, lie there a while, then get
          // pulled onto the net.
          tl.fromTo(
            f.el,
            { opacity: 0, x: f.sx + f.dx * 4, y: f.sy + f.dy * 4, rotation: f.rot, scale: 0.85 },
            { opacity: 1, x: f.sx, y: f.sy, scale: 1, duration: 0.16 },
            0.03 + (i / n) * 0.27
          ).to(
            f.el,
            { x: f.tx, y: f.ty, rotation: 0, scale: 0.84, duration: 0.24 },
            0.5 + (i / n) * 0.16
          )
        })

        if (hProblem) tl.to(hProblem, { opacity: 0, y: -26, duration: 0.1 }, 0.42)
        if (hSolution) {
          tl.fromTo(
            hSolution,
            { opacity: 0, xPercent: -50, y: 18 },
            { opacity: 1, y: 0, duration: 0.1 },
            0.52
          )
        }
        if (solutionCard) {
          tl.fromTo(
            solutionCard,
            { opacity: 0, xPercent: -50, yPercent: -50, scale: 0.8 },
            { opacity: 1, scale: 1, duration: 0.14 },
            0.56
          )
        }
        if (lineEls?.length) {
          tl.fromTo(
            lineEls,
            { drawSVG: 0, opacity: 0 },
            { drawSVG: '100%', opacity: 0.45, duration: 0.26, stagger: 0.045 },
            0.68
          )
        }
      }, wrap)
    }

    build()
    let t = 0
    let live = true
    const onResize = () => {
      window.clearTimeout(t)
      t = window.setTimeout(build, 200)
    }
    window.addEventListener('resize', onResize)
    // A promise cannot be cancelled the way a timeout can, so the flag is what
    // stops a late-resolving `fonts.ready` from building a timeline and a
    // ScrollTrigger into a branch that matchMedia has already torn down.
    document.fonts?.ready.then(() => {
      if (live) build()
    })

    return () => {
      live = false
      window.clearTimeout(t)
      window.removeEventListener('resize', onResize)
      ctx?.revert()
      ctx = null
    }
  })
}

initHeroCta()
initAura()
initPins()
initReveals()
initSheetIndex()
initChain()
initRoi()
