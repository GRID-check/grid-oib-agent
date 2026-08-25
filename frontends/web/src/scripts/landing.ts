import { animate, inView, scrollInfo, type AnimationPlaybackControls } from 'motion'
import { landingScript } from '../i18n/ui'
import { initReveals } from './reveal'
import { initRoi } from './roi'
import { initSheetIndex } from './sheet-index'

const L = document.documentElement.lang.startsWith('en') ? landingScript.en : landingScript.de

const TYPE = 1900
const RATE = 1.18
const LOOP = 13600

/**
 * The chain's storyboard: which subjects are in frame at each moment, by the
 * `data-shot` names authored on the mock.
 *
 * Coordinates are deliberately absent. The previous version pinned the camera
 * to hand-tuned x/y/z, which framed a card only as long as nothing about it
 * changed — a longer German string, a different panel width, and the shot cut
 * through the middle of a card. Naming the subject and measuring it means the
 * camera always frames whole elements, in any locale, at any size.
 */
const SHOTS: { t: number; on: string[]; tight?: string }[] = [
  { t: 0, on: ['q', 's1'], tight: 'q' },
  { t: 1500, on: ['q', 's1'], tight: 'q' },
  { t: 2200, on: ['q', 's1'] },
  { t: 2900, on: ['q', 's1', 's2'] },
  { t: 3500, on: ['s1', 's2', 's3'] },
  { t: 4300, on: ['s1', 's2', 's3'] },
  // `tight` is the subject a phone frames instead of the group. It matters where
  // the group looks ahead to something that has not arrived yet: framing the
  // empty place the decision card is about to occupy shows a phone nothing.
  { t: 4900, on: ['s1', 's2', 's3', 'dec'], tight: 's3' },
  { t: 5600, on: ['dec'] },
  { t: 6600, on: ['dec'] },
  { t: 7300, on: ['dec', 'impl'], tight: 'dec' },
  { t: 8200, on: ['impl'] },
  { t: 9400, on: ['all'], tight: 'impl' },
  { t: 11000, on: ['all'], tight: 'impl' },
]

const BEATS = [
  { t: 0, step: 0 },
  { t: 400, step: 1 },
  { t: 1500, step: 2 },
  { t: 2700, step: 3 },
  { t: 3300, step: 4 },
  { t: 3900, step: 5 },
  { t: 4000, step: 6 },
  { t: 5300, step: 7 },
  { t: 6150, step: 8 },
  { t: 6950, step: 9 },
  { t: 9300, step: 10 },
]

const clamp = (v: number) => Math.max(0, Math.min(1, v))
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

function initHeroCta() {
  const cta = document.querySelector<HTMLElement>('[data-hero-cta]')
  if (!cta) return
  const wrap = document.querySelector<HTMLElement>('[data-hero-wrap]')
  if (wrap && !reduced) wrap.style.height = '200vh'
  const apply = (scrollY: number) => {
    const on = scrollY > window.innerHeight * 0.12
    cta.style.opacity = on ? '0' : '1'
    cta.style.transform = on ? 'translateY(-10px)' : 'translateY(0)'
    cta.style.pointerEvents = on ? 'none' : 'auto'
  }
  apply(window.scrollY)
  scrollInfo(({ y }) => apply(y.current))
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
    const rings: [number, number, number][] = [
      [104, 0.06, 0.22],
      [162, -0.04, 0.17],
      [224, 0.028, 0.12],
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
    NODES.forEach((n, i) => {
      const ang = n.a + ts * n.v
      const nx = hx + Math.cos(ang) * n.r * sc
      const ny = hy + Math.sin(ang) * n.r * sc * 0.86
      const glow = 0.5 + 0.5 * Math.sin(ts * 1.1 + i)
      ctx.strokeStyle = `rgba(94,110,70,${(0.09 + 0.09 * glow).toFixed(3)})`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(hx, hy)
      ctx.lineTo(nx, ny)
      ctx.stroke()
      ctx.fillStyle = `rgba(88,104,64,${(0.45 + 0.45 * glow).toFixed(3)})`
      ctx.beginPath()
      ctx.arc(nx, ny, (1.6 + 0.9 * glow) * Math.max(1, sc * 0.8), 0, Math.PI * 2)
      ctx.fill()
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
        lines.forEach((ln, li) => {
          ctx.fillStyle = `rgba(88,104,64,${((li === 0 ? 0.35 : 0.24) + 0.35 * glow).toFixed(3)})`
          ctx.fillText(ln, lx, ny - 5 * sc + li * lh)
        })
        ctx.textAlign = 'left'
      }
    })

    BEAMS.forEach((b, i) => {
      const [bx, by] = P(b[0], b[1])
      const cyc = (ts * 0.42 + i / BEAMS.length) % 1
      const grow = Math.min(1, cyc / 0.55)
      const fade = cyc > 0.78 ? 1 - (cyc - 0.78) / 0.22 : 1
      if (fade <= 0) return
      ctx.strokeStyle = `rgba(94,110,70,${(0.28 * fade).toFixed(3)})`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(hx, hy)
      ctx.lineTo(hx + (bx - hx) * grow, hy + (by - hy) * grow)
      ctx.stroke()
      if (grow >= 1) {
        ctx.fillStyle = `rgba(88,104,64,${(0.6 * fade).toFixed(3)})`
        ctx.beginPath()
        ctx.arc(bx, by, 2.4 * Math.max(1, sc * 0.8), 0, Math.PI * 2)
        ctx.fill()
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

  let loop: AnimationPlaybackControls | null = null
  let onScreen = false
  const sync = () => {
    if (onScreen && !document.hidden) {
      if (!loop) {
        loop = animate(0, 1, {
          duration: 60,
          repeat: Infinity,
          ease: 'linear',
          onUpdate: () => draw(performance.now()),
        })
      } else {
        loop.play()
      }
    } else {
      loop?.pause()
    }
  }
  inView(cv, () => {
    onScreen = true
    sync()
    return () => {
      onScreen = false
      sync()
    }
  })
  document.addEventListener('visibilitychange', sync)
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

  let lineEls: { el: SVGLineElement; len: number }[] | null = null
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
        l.style.opacity = '0'
        linksSvg.appendChild(l)
        return { el: l, len: 0 }
      })
    }
    if (linksSvg) linksSvg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    lineEls?.forEach((l, i) => {
      const f = fragEls[i]
      // Fragments that were left out get a zero-length line, which draws nothing.
      const x = f.fits ? f.hx + f.tx : hub.x
      const y = f.fits ? f.hy + f.ty : hub.y
      l.el.setAttribute('x1', String(hub.x))
      l.el.setAttribute('y1', String(hub.y))
      l.el.setAttribute('x2', String(x))
      l.el.setAttribute('y2', String(y))
      l.len = Math.hypot(x - hub.x, y - hub.y)
      l.el.style.strokeDasharray = String(l.len)
    })
  }

  const setStatic = () => {
    fragEls.forEach((f) => {
      f.el.style.opacity = '1'
      f.el.style.transform = `translate(${f.tx}px,${f.ty}px)`
    })
    lineEls?.forEach((l) => {
      l.el.style.strokeDashoffset = '0'
      l.el.style.opacity = '0.45'
    })
    if (hProblem) hProblem.style.opacity = '0'
    if (hSolution) hSolution.style.opacity = '1'
    if (solutionCard) {
      solutionCard.style.opacity = '1'
      solutionCard.style.transform = 'translate(-50%,-50%) scale(1)'
    }
  }

  if (reduced) {
    measureStory()
    setStatic()
    return
  }

  sticky.style.position = 'sticky'
  sticky.style.top = '0'
  sticky.style.boxSizing = 'border-box'

  const sizePins = () => {
    sticky.style.height = 'auto'
    sticky.style.overflow = 'visible'
    if (sticky.scrollHeight <= window.innerHeight) {
      sticky.style.height = '100vh'
      sticky.style.overflow = 'hidden'
    }
    measureStory()
    // The scroll runway is the beat list's length: the ring adds the fan-out
    // and the connecting lines, the grid does not, so it needs less scrolling.
    wrap.style.height = mode === 'ring' ? '440vh' : '300vh'
  }

  let navHidden = false
  const setNavHidden = (hide: boolean) => {
    if (!nav || hide === navHidden) return
    navHidden = hide
    animate(
      nav,
      { y: hide ? '-110%' : '0%', opacity: hide ? 0 : 1 },
      { duration: 0.5, ease: 'easeOut' }
    )
    nav.toggleAttribute('inert', hide)
    if (hide) nav.setAttribute('aria-hidden', 'true')
    else nav.removeAttribute('aria-hidden')
  }

  const update = (p: number, hide: boolean) => {
    setNavHidden(hide)
    const n = fragEls.length
    fragEls.forEach((f, i) => {
      const inStart = 0.03 + (i / n) * 0.27
      const eIn = easeOut(clamp((p - inStart) / 0.16))
      const orgStart = 0.5 + (i / n) * 0.16
      const eOrg = easeOut(clamp((p - orgStart) / 0.24))
      // drift in → lie scattered → get pulled onto the net
      const tx = f.dx * 4 * (1 - eIn) + f.sx + (f.tx - f.sx) * eOrg
      const ty = f.dy * 4 * (1 - eIn) + f.sy + (f.ty - f.sy) * eOrg
      const sc = (0.85 + 0.15 * eIn) * (1 - 0.16 * eOrg)
      const rot = f.rot * (1 - eOrg)
      f.el.style.opacity = String(eIn)
      f.el.style.transform = `translate(${tx}px,${ty}px) rotate(${rot}deg) scale(${sc})`
    })
    if (hProblem) {
      const out = easeOut(clamp((p - 0.42) / 0.1))
      hProblem.style.opacity = String(1 - out)
      hProblem.style.transform = `translateY(${-26 * out}px)`
    }
    if (hSolution) {
      const sIn = easeOut(clamp((p - 0.52) / 0.1))
      hSolution.style.opacity = String(sIn)
      hSolution.style.transform = `translateX(-50%) translateY(${18 * (1 - sIn)}px)`
    }
    if (solutionCard) {
      const ce = easeOut(clamp((p - 0.56) / 0.14))
      solutionCard.style.opacity = String(ce)
      solutionCard.style.transform = `translate(-50%,-50%) scale(${0.8 + 0.2 * ce})`
    }
    if (lineEls) {
      const lp = clamp((p - 0.68) / 0.26)
      lineEls.forEach((l, i) => {
        const se = easeOut(clamp((lp - i * 0.045) / 0.55))
        l.el.style.strokeDashoffset = String(l.len * (1 - se))
        l.el.style.opacity = String(0.45 * se)
      })
    }
  }

  sizePins()
  window.addEventListener('resize', sizePins)
  scrollInfo(
    ({ y }) => {
      const r = wrap.getBoundingClientRect()
      const vh = window.innerHeight
      update(y.progress, r.top < vh * 0.4 && r.bottom > vh * 0.5)
    },
    { target: wrap, offset: ['start start', 'end end'] }
  )
  setTimeout(measureStory, 700)
}

type Cam = { t: number; x: number; y: number; z: number }

/**
 * Catmull-Rom through the measured frames, clamped to the segment so an
 * overshoot can never swing the camera off the diagram.
 */
function camAt(K: Cam[], ms: number) {
  const n = K.length
  if (ms <= K[0].t) return K[0]
  if (ms >= K[n - 1].t) return K[n - 1]
  let i = 0
  while (i < n - 2 && ms > K[i + 1].t) i++
  const a = K[Math.max(0, i - 1)]
  const b = K[i]
  const c = K[i + 1]
  const d = K[Math.min(n - 1, i + 2)]
  const u = (ms - b.t) / Math.max(1, c.t - b.t)
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) => {
    const t2 = t * t
    const t3 = t2 * t
    return (
      0.5 *
      (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    )
  }
  const axis = (p0: number, p1: number, p2: number, p3: number) => {
    const v = cr(p0, p1, p2, p3, u)
    return Math.max(Math.min(p1, p2), Math.min(Math.max(p1, p2), v))
  }
  return { t: ms, x: axis(a.x, b.x, c.x, d.x), y: axis(a.y, b.y, c.y, d.y), z: axis(a.z, b.z, c.z, d.z) }
}

function initChain() {
  const anchor = document.querySelector<HTMLElement>('[data-chat-anchor]')
  const stage = anchor?.querySelector<HTMLElement>('[data-stage]')
  const camEl = anchor?.querySelector<HTMLElement>('[data-cam]')
  const qEl = anchor?.querySelector<HTMLElement>('[data-q-text]')
  const caretEl = anchor?.querySelector<HTMLElement>('[data-q-caret]')
  const statusEl = anchor?.querySelector<HTMLElement>('[data-status]')
  const replayBtn = anchor?.querySelector<HTMLButtonElement>('[data-replay]')
  if (!anchor || !stage || !camEl || !qEl || !statusEl) return

  const gated = Array.from(
    anchor.querySelectorAll<HTMLElement | SVGGElement>('[data-step-gte], [data-step-eq]')
  )
  const opts = ['a', 'b', 'c'].map((k) => anchor.querySelector<HTMLElement>(`[data-opt="${k}"]`))

  const setStep = (step: number) => {
    gated.forEach((el) => {
      const gte = el.getAttribute('data-step-gte')
      const eq = el.getAttribute('data-step-eq')
      const on = gte != null ? step >= Number(gte) : step === Number(eq)
      el.toggleAttribute('data-active', on)
    })
    opts.forEach((el, i) => {
      if (!el) return
      const key = 'abc'[i]
      if (key === 'b') {
        el.toggleAttribute('data-picked', step >= 8)
        el.removeAttribute('data-dimmed')
      } else {
        el.toggleAttribute('data-dimmed', step >= 8)
      }
    })
  }

  const setCam = (c: { x: number; y: number; z: number }) => {
    const r = stage.getBoundingClientRect()
    const vw = r.width || 700
    const vh = r.height || 430
    const tx = vw / 2 - c.x * c.z
    const ty = vh / 2 - c.y * c.z
    camEl.style.transform = `translate3d(${tx.toFixed(2)}px,${ty.toFixed(2)}px,0) scale(${c.z.toFixed(4)})`
  }

  type Box = { x: number; y: number; w: number; h: number }

  /**
   * Turn the storyboard into camera frames for the size the mock actually has.
   *
   * Each shot is the bounding box of its subjects plus a margin, scaled to fit
   * the stage and never magnified past 1: the mock is drawn at its true size,
   * so anything above 1 would only soften it. The bottom inset is larger
   * because the status line sits over the frame.
   */
  const INSET = { top: 22, right: 24, bottom: 48, left: 24 }
  const TIGHT_INSET = { top: 14, right: 12, bottom: 40, left: 12 }
  const MARGIN = 14

  const boxOf = (els: HTMLElement[]): Box | null => {
    if (!els.length) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const el of els) {
      x0 = Math.min(x0, el.offsetLeft)
      y0 = Math.min(y0, el.offsetTop)
      x1 = Math.max(x1, el.offsetLeft + el.offsetWidth)
      y1 = Math.max(y1, el.offsetTop + el.offsetHeight)
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  const shotEls = (name: string) =>
    Array.from(
      camEl.querySelectorAll<HTMLElement>(name === 'all' ? '[data-shot]' : `[data-shot="${name}"]`)
    )

  const buildCam = (): Cam[] => {
    const r = stage.getBoundingClientRect()
    const vw = r.width || 700
    const vh = r.height || 430
    const world = boxOf(shotEls('all')) ?? { x: 0, y: 0, w: 1160, h: 670 }
    // A phone cannot hold two subjects side by side at a readable size, so it
    // follows the newest one instead of pulling back to a composition shot.
    const narrow = vw < 560

    const inset = narrow ? TIGHT_INSET : INSET
    const margin = narrow ? 8 : MARGIN

    return SHOTS.map((shot) => {
      const names = narrow ? [shot.tight ?? shot.on[shot.on.length - 1]] : shot.on
      let els = names.flatMap(shotEls)
      // On a phone even one subject can be too wide to read: a source row is a
      // chip plus its card. Frame the card — the part that carries the words —
      // and let the chip sit outside the shot.
      if (narrow && els.length > 1) {
        els = [els.reduce((a, b) => (a.offsetWidth * a.offsetHeight >= b.offsetWidth * b.offsetHeight ? a : b))]
      }
      const box = boxOf(els) ?? world
      const bw = box.w + margin * 2
      const bh = box.h + margin * 2
      const z = Math.min(1, (vw - inset.left - inset.right) / bw, (vh - inset.top - inset.bottom) / bh)

      // Centre the subject in the *inset* frame, not the raw rectangle.
      let x = box.x + box.w / 2 - (inset.left - inset.right) / 2 / z
      let y = box.y + box.h / 2 - (inset.top - inset.bottom) / 2 / z

      // The subject is centred rather than clamped to the diagram's bounds. A
      // clamp pinned the opening shot's bubble into the corner of the frame,
      // which reads as a mistake; empty space around a close-up does not, and
      // the frame's edges fade anyway.
      return { t: shot.t, x, y, z }
    })
  }

  // Every element is measured with its step-gating off, so a card that has not
  // appeared yet still reports the size it will have — the camera is already
  // framing the place it arrives in.
  let cam = buildCam()
  // Card heights depend on how the copy wraps, which depends on the webfont:
  // measured before it lands, a card can be a line taller than the frame allows.
  document.fonts?.ready.then(() => {
    cam = buildCam()
  })

  if (reduced) {
    setStep(10)
    setCam(cam[cam.length - 1])
    statusEl.textContent = L.beats[10]
    if (replayBtn) replayBtn.hidden = true
    return
  }

  const applyFrame = (raw: number) => {
    const p = Math.min(1, raw / (TYPE - 350))
    const n = Math.round(L.question.length * p)
    const txt = L.question.slice(0, n)
    if (qEl.textContent !== txt) qEl.textContent = txt
    if (caretEl) caretEl.style.display = p < 1 ? 'inline-block' : 'none'
    if (raw < TYPE) {
      if (statusEl.textContent !== L.typing) statusEl.textContent = L.typing
      setStep(0)
      setCam(cam[0])
      return
    }
    const ms = raw - TYPE
    setCam(camAt(cam, ms))
    let bi = 0
    for (let i = 0; i < BEATS.length; i++) if (ms >= BEATS[i].t) bi = i
    setStep(BEATS[bi].step)
    const label = L.beats[bi]
    if (statusEl.textContent !== label) statusEl.textContent = label
  }

  const controls = animate(0, LOOP, {
    duration: LOOP / RATE / 1000,
    ease: 'linear',
    repeat: Infinity,
    autoplay: false,
    onUpdate: applyFrame,
  })

  let onScreen = false
  const sync = () => {
    if (onScreen && !document.hidden) controls.play()
    else controls.pause()
  }
  inView(
    anchor,
    () => {
      onScreen = true
      sync()
      return () => {
        onScreen = false
        sync()
      }
    },
    { amount: 0.35 }
  )
  document.addEventListener('visibilitychange', sync)

  replayBtn?.addEventListener('click', () => {
    controls.time = 0
    controls.play()
  })

  // The frames are a function of the mock's size, so they are re-solved when it
  // changes rather than being stretched out of shape.
  let resizeTimer = 0
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      cam = buildCam()
    }, 150)
  })
}

initHeroCta()
initAura()
initPins()
initReveals()
initSheetIndex()
initChain()
initRoi()
