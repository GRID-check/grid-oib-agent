import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { landingScript } from '../i18n/ui'
import { MQ, TRAVEL, sec, staggerFor } from '../lib/motion'
import { gsap } from './motion-gsap'

gsap.registerPlugin(DrawSVGPlugin, ScrollTrigger)
import { initReveals } from './reveal'
import { initChain } from './chain'
import { initRoi } from './roi'
import { initSheetIndex } from './sheet-index'

const L = document.documentElement.lang.startsWith('en') ? landingScript.en : landingScript.de


const reduced = window.matchMedia(MQ.reduced).matches

/**
 * The breakpoint at which the landing page becomes a sequence of full screens
 * with a pinned, scrubbed story. Below it every section has its natural height
 * and nothing holds the scroll: on a phone a pin is a page that stops
 * answering the thumb, and a scrubbed runway is a screen of scrolling past a
 * still image. Mirrors Tailwind's `lg`.
 */
const STAGED = MQ.staged
const MOTION = MQ.motion
const REDUCED = MQ.reduced

/**
 * The hero's lockup yields as the page moves on: the closing line, its
 * buttons and the stage note over the first quarter screen, the headline a
 * little later. Opacity only, scrubbed to the hero's own scroll-out. Without
 * it they print through the logo on the way up, while the bar over the hero
 * is still transparent (nav.ts condenses it at 60% of the hero).
 *
 * There is no runway: a 200vh wrapper would let the closing line fade while the
 * photograph held still, a screen of scrolling in which nothing happened. Below
 * lg, or without motion, the hero is a plain screen that scrolls away.
 */
function initHeroCta() {
  const cta = document.querySelector<HTMLElement>('[data-hero-cta]')
  const hero = document.querySelector<HTMLElement>('[data-hero]')
  if (!cta || !hero) return
  const stage = hero.querySelector<HTMLElement>('[data-hero-stage]')
  const title = hero.querySelector<HTMLElement>('[data-hero-title]')
  gsap.matchMedia().add(`${STAGED} and ${MOTION}`, () => {
    const vh = () => window.innerHeight
    const fade = (targets: (HTMLElement | null)[], from: number, to: number, onUpdate?: (p: number) => void) =>
      gsap.to(targets.filter(Boolean), {
        opacity: 0,
        ease: 'none',
        scrollTrigger: {
          trigger: hero,
          start: () => `top+=${vh() * from} top`,
          end: () => `top+=${vh() * to} top`,
          scrub: true,
          onUpdate: onUpdate && ((self) => onUpdate(self.progress)),
        },
      })
    fade([cta, stage], 0, 0.25, (p) => {
      cta.style.pointerEvents = p > 0.6 ? 'none' : ''
    })
    fade([title], 0.2, 0.5)
    return () => {
      cta.style.pointerEvents = ''
    }
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
  /**
   * The two photographs the hero can show, in their own pixel coordinates:
   * where her head is, where the beams land on the plan, and how far out the
   * orbit runs (`R`, a multiplier on the authored radii). The portrait frame
   * is shot from higher, so the same figure is smaller in it and the orbit
   * reaches further out to fill the floor around her.
   */
  const PHOTOS = {
    landscape: {
      IW: 1376,
      IH: 768,
      HEAD: [700, 196] as [number, number],
      R: 1,
      BEAMS: [
        [600, 330],
        [792, 318],
        [648, 424],
        [742, 400],
        [700, 372],
      ] as [number, number][],
    },
    portrait: {
      IW: 3840,
      IH: 6480,
      HEAD: [1941, 2613] as [number, number],
      R: 6.5,
      BEAMS: [
        [1650, 3050],
        [2250, 3000],
        [1800, 3350],
        [2150, 3300],
        [1950, 3200],
      ] as [number, number][],
    },
  }
  const portraitQuery = cv.dataset.portraitMedia ? window.matchMedia(cv.dataset.portraitMedia) : null
  let photo = PHOTOS.landscape
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
    photo = portraitQuery?.matches ? PHOTOS.portrait : PHOTOS.landscape
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    sc = Math.max(w / photo.IW, h / photo.IH)
    ox = (w - photo.IW * sc) / 2
    oy = (h - photo.IH * sc) / 2
    return true
  }
  resize()
  window.addEventListener('resize', resize)
  portraitQuery?.addEventListener('change', resize)
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

  const draw = (t: number) => {
    if (!cv.isConnected) return
    if (cv.width !== Math.round(cv.getBoundingClientRect().width * dpr)) {
      if (!resize()) return
    }
    if (!w || !h) return

    ctx.clearRect(0, 0, w, h)
    const [hx, hy] = P(photo.HEAD[0], photo.HEAD[1])
    // Orbit scale: the authored radii times the photograph's own multiplier.
    const os = sc * photo.R
    const ts = t / 1000
    const TOP = 74
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, TOP, w, Math.max(0, h - TOP))
    ctx.clip()

    const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, 250 * os)
    const pulse = 0.1 + 0.03 * Math.sin(ts * 0.7)
    halo.addColorStop(0, `rgba(120,140,88,${pulse.toFixed(3)})`)
    halo.addColorStop(1, 'rgba(120,140,88,0)')
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(hx, hy, 250 * os, 0, Math.PI * 2)
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
      ctx.setLineDash([13 * Math.max(sc, 0.6), 11 * Math.max(sc, 0.6)])
      ctx.beginPath()
      ctx.arc(0, 0, r * os, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    })
    ctx.setLineDash([])

    // 11px is the floor for any text on the site, the canvas included.
    ctx.font = `${(11 * Math.max(1, sc * 0.75)).toFixed(1)}px 'IBM Plex Mono', monospace`
    ctx.letterSpacing = '0.08em'
    NODES.forEach((n, i) => {
      const ang = n.a + ts * n.v
      const nx = hx + Math.cos(ang) * n.r * os
      const ny = hy + Math.sin(ang) * n.r * os * 0.86
      const glow = 0.5 + 0.5 * Math.sin(ts * 1.1 + i)
      // A leader line is drawn to the nodes that say something, and only
      // suggested for the rest, so the eye follows the labels.
      const named = Boolean(n.label)
      // The line gathers as it travels out — but it also has to START further
      // out. A gradient that begins at zero still converges on the same pixel as
      // the other eleven, and twelve nearly-invisible strokes stacked on one
      // point add up to a visible one, tying the fan in a knot at her head. So
      // each ray begins clear of the halo and there is nothing at the centre to
      // accumulate.
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
      // room for it. Written blindly to the right, the ones on a phone would run
      // off the canvas and read as a column of broken words down the edge.
      const EDGE = 12
      if (n.label && nx > EDGE && nx < w - EDGE) {
        // A phone has no room for the three-line archive cards; the project
        // name alone says the same thing.
        const lines = Array.isArray(n.label)
          ? photo === PHOTOS.portrait
            ? [n.label[1]]
            : n.label
          : [n.label]
        const lh = 13 * Math.max(1, sc * 0.75)
        const textW = Math.max(...lines.map((ln) => ctx.measureText(ln).width))
        const right = nx + 7 * Math.max(1, sc)
        const flip = right + textW > w - EDGE && nx - 7 * Math.max(1, sc) - textW > EDGE
        ctx.textAlign = flip ? 'right' : 'left'
        const lx = flip ? nx - 7 * Math.max(1, sc) : Math.min(right, Math.max(EDGE, w - EDGE - textW))
        // A halo in the paper's own colour, not a shadow: the labels cross hair,
        // sleeve and drawing in one pass, and this is what keeps 9px mono legible
        // over all three without putting a box behind it.
        ctx.save()
        ctx.shadowColor = 'rgba(247,247,243,0.95)'
        ctx.shadowBlur = 7 * Math.max(1, sc * 0.7)
        lines.forEach((ln, li) => {
          ctx.fillStyle = `rgba(78,92,56,${((li === 0 ? 0.44 : 0.3) + 0.3 * glow).toFixed(3)})`
          ctx.fillText(ln, lx, ny - 5 * Math.max(1, sc) + li * lh)
          ctx.fillText(ln, lx, ny - 5 * Math.max(1, sc) + li * lh)
        })
        ctx.restore()
        ctx.textAlign = 'left'
      }
    })

    photo.BEAMS.forEach((b, i) => {
      const [bx, by] = P(b[0], b[1])
      const cyc = (ts * 0.42 + i / photo.BEAMS.length) % 1
      const grow = Math.min(1, cyc / 0.55)
      const fade = cyc > 0.78 ? 1 - (cyc - 0.78) / 0.22 : 1
      if (fade <= 0) return
      // Five beams drawn from the exact centre at 0.28 alpha would stack on one
      // pixel and tie the knot again, so they leave from the same clear radius
      // the leader lines do, and fade in over it.
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

/**
 * Where a node rests around the hub, in -1..1 of the room on either side of
 * it: `u` across (1 is the panel's edge), `v` down (-1 is just under the
 * headline, 1 the foot of the ring).
 */
interface At {
  u: number
  v: number
}

interface Frag {
  el: HTMLElement
  /** Entrance offset, in the direction the fragment drifts in from. */
  dx: number
  dy: number
  at: At
  /** Measured size and resting (CSS) centre inside the panel. */
  w: number
  h: number
  hx: number
  hy: number
  /** Scattered beat: where the fragment lies before it is organised. */
  sx: number
  sy: number
  rot: number
  /** Solved place: translation from the resting centre, and whether it fits. */
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

/** Where a ray from a rect's centre, along (dx, dy), leaves the rect. */
const rim = (r: Rect, dx: number, dy: number) => {
  const t = Math.min(dx ? r.w / 2 / Math.abs(dx) : Infinity, dy ? r.h / 2 / Math.abs(dy) : Infinity)
  return { x: r.x + dx * t, y: r.y + dy * t }
}

/** A centred rect: `x`/`y` is the centre, as everywhere in the story solver. */
interface StoryLayout {
  mode: 'ring' | 'net'
  hub: Rect
  /** Top edge of the solution headline, in panel pixels. */
  headTop: number
  /** One SVG path per fragment, hub edge to node edge; '' for one left out. */
  wires: string[]
  /** Where each wire lands on its node: the port drawn there. */
  ends: ({ x: number; y: number } | null)[]
}

/**
 * The finished hub on a landscape panel: the headline on top, and under it
 * the hub card with the nodes exploded around it, each on a straight wire.
 *
 * The ring lives entirely below the headline, so no wire passes under the
 * words or stops short of anything. Each wire runs along the line between the
 * two centres, from where it leaves the hub card's edge to where it meets the
 * node's, so the wires converge on the card without entering it. The ring's
 * height follows the panel's up to a ceiling, and the whole composition is
 * centred in the panel. Returns null when the nodes would touch each other or
 * the card (a panel too small for the ring).
 */
function solveRing(frags: Frag[], W: number, H: number, card: { w: number; h: number }, headH: number) {
  const PAD_X = 24
  const PAD_Y = 40
  const HEAD_GAP = 48
  const RX_MAX = 500
  const SPAN_MAX = 560
  const UP_SHARE = 0.4
  const GAP = 12

  const nodeH = Math.max(0, ...frags.map((f) => f.h))
  const span = Math.min(SPAN_MAX, H - PAD_Y * 2 - headH - HEAD_GAP - nodeH)
  if (span <= card.h) return null
  const up = span * UP_SHARE
  const down = span - up
  const headTop = (H - (headH + HEAD_GAP + nodeH + span)) / 2
  const hub = { x: W / 2, y: headTop + headH + HEAD_GAP + nodeH / 2 + up, w: card.w, h: card.h }

  const rects = frags.map((f) => {
    const reach = Math.min(RX_MAX, W / 2 - PAD_X - f.w / 2)
    return { x: hub.x + f.at.u * reach, y: hub.y + f.at.v * (f.at.v < 0 ? up : down), w: f.w, h: f.h }
  })
  const clash = rects.some(
    (r, i) => overlaps(r, hub, GAP * 2) || rects.some((s, j) => j > i && overlaps(r, s, GAP))
  )
  if (clash) return null

  const ends: { x: number; y: number }[] = []
  const wires = rects.map((r, i) => {
    const f = frags[i]
    f.tx = r.x - f.hx
    f.ty = r.y - f.hy
    f.sx = 0
    f.sy = 0
    f.rot = (noise(i + 1) - 0.5) * 7
    f.fits = true
    const len = Math.hypot(r.x - hub.x, r.y - hub.y) || 1
    const dx = (r.x - hub.x) / len
    const dy = (r.y - hub.y) / len
    const a = rim(hub, dx, dy)
    const b = rim(r, -dx, -dy)
    ends.push(b)
    return `M${a.x},${a.y}L${b.x},${b.y}`
  })
  return { mode: 'ring' as const, hub, headTop, wires, ends }
}

/**
 * Places the knowledge fragments around the hub card.
 *
 * The arrangement is solved from measurements rather than chosen by a
 * breakpoint. A landscape panel holds the ring (solveRing). One that cannot —
 * the nodes would touch each other or the card —
 * falls back to a `net`: the same fragments spread as a jittered
 * constellation below the hub. Both are wired to the hub, because that is the
 * point being made; only the shape of the net changes with the space.
 */
function solveStoryLayout(
  frags: Frag[],
  panel: Rect,
  card: { w: number; h: number },
  headH: number
): StoryLayout {
  const ring = solveRing(frags, panel.w, panel.h, card, headH)
  if (ring) return ring

  const PAD = 20
  const GAP = 18
  const gridHub = { x: panel.w / 2, y: panel.h * 0.4, w: card.w, h: card.h }

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

  // Straight wires from the hub's foot to the top edge of each node.
  const foot = gridHub.y + gridHub.h / 2
  const ends = frags.map((f) => (f.fits ? { x: f.hx + f.tx, y: f.hy + f.ty - f.h / 2 } : null))
  const wires = ends.map((e) => (e ? `M${gridHub.x},${foot}L${e.x},${e.y}` : ''))
  return { mode: 'net', hub: gridHub, headTop: panel.h * 0.11, wires, ends }
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

  const fragEls: Frag[] = Array.from(wrap.querySelectorAll<HTMLElement>('[data-frag]')).map(
    (el) => {
      const [dx, dy] = (el.getAttribute('data-frag') ?? '0,0').split(',').map(Number)
      const [u, v] = (el.getAttribute('data-at') ?? '0,1').split(',').map(Number)
      el.style.willChange = 'transform, opacity'
      el.style.opacity = '0'
      return {
        el, dx, dy, at: { u, v },
        w: 0, h: 0, hx: 0, hy: 0,
        sx: 0, sy: 0, rot: 0,
        tx: 0, ty: 0, fits: true,
      }
    }
  )
  // The wires draw in mirrored pairs from the top of the ring to its foot:
  // the structure grows symmetrically out of the hub.
  const drawOrder = fragEls
    .map((f, i) => ({ i, rank: f.at.v * 10 + (f.at.u > 0 ? 1 : 0) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ i }) => i)

  let wireEls: SVGPathElement[] | null = null
  let portEls: SVGCircleElement[] | null = null
  let mode: StoryLayout['mode'] = 'ring'

  const measureStory = () => {
    const W = panel.clientWidth
    const H = panel.clientHeight
    if (!W || !H) return

    const card = { w: solutionCard?.offsetWidth ?? 0, h: solutionCard?.offsetHeight ?? 0 }
    const headH = hSolution?.offsetHeight ?? 0

    // Back to intrinsic size before measuring — net mode stretches the
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

    const layout = solveStoryLayout(fragEls, { x: 0, y: 0, w: W, h: H }, card, headH)
    mode = layout.mode
    if (solutionCard) solutionCard.style.top = `${layout.hub.y}px`
    if (hSolution) hSolution.style.top = `${layout.headTop}px`
    fragEls.forEach((f) => {
      if (!f.fits) f.el.style.display = 'none'
    })

    if (linksSvg && !wireEls) {
      const NS = 'http://www.w3.org/2000/svg'
      wireEls = fragEls.map(() => {
        const p = document.createElementNS(NS, 'path')
        p.setAttribute('fill', 'none')
        p.setAttribute('stroke', '#6e7d52')
        p.setAttribute('stroke-width', '1.25')
        p.setAttribute('stroke-linejoin', 'round')
        linksSvg.appendChild(p)
        return p
      })
      portEls = fragEls.map(() => {
        const c = document.createElementNS(NS, 'circle')
        c.setAttribute('r', '2.5')
        c.setAttribute('fill', '#a4b47a')
        linksSvg.appendChild(c)
        return c
      })
    }
    if (linksSvg) linksSvg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    // A fragment left out gets an empty path and no port, which draw nothing.
    wireEls?.forEach((p, i) => p.setAttribute('d', layout.wires[i]))
    portEls?.forEach((c, i) => {
      const e = layout.ends[i]
      c.setAttribute('cx', String(e?.x ?? -10))
      c.setAttribute('cy', String(e?.y ?? -10))
      c.setAttribute('r', e ? '2.5' : '0')
    })
  }

  /**
   * The story, as one scrubbed timeline.
   *
   * A timeline says the same thing as a score: this fragment drifts in here, the
   * net pulls it into place there. GSAP owns the interpolation, DrawSVGPlugin
   * owns the lines, and ScrollTrigger owns the scrubbing, so the only thing
   * written here is the order of events. Hand-computed per-frame transforms
   * would leave the choreography in expressions like `0.03 + (i / n) * 0.27`,
   * readable only by simulating them.
   */
  const setNavHidden = (hide: boolean) => {
    if (!nav || hide === navHidden) return
    navHidden = hide
    gsap.to(nav, { y: hide ? '-110%' : '0%', opacity: hide ? 0 : 1, duration: sec('base'), ease: 'settle' })
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
    // The scroll runway is the beat list's length: the ring adds the pull-in
    // and the wiring, the net does not, so it needs less scrolling. The beats
    // below fill the range, so the story takes about one screen of scrolling
    // per idea.
    wrap.style.height = runway ? (mode === 'ring' ? '240vh' : '200vh') : ''
  }
  /** Back to a plain block: what the section is below lg. */
  const unpin = () => {
    for (const p of ['position', 'top', 'boxSizing', 'height', 'overflow'] as const) sticky.style[p] = ''
    wrap.style.height = ''
  }

  // Below lg none of this runs: the stage is not displayed, and the section is
  // the static hub grid that initHubGrid wires up.
  const mm = gsap.matchMedia()

  mm.add(`${STAGED} and ${REDUCED}`, () => {
    sizePins(false)
    fragEls.forEach((f) => gsap.set(f.el, { opacity: 1, x: f.tx, y: f.ty, rotation: 0, scale: 1 }))
    if (wireEls) gsap.set(wireEls, { drawSVG: '100%' })
    if (portEls) gsap.set(portEls, { opacity: 1 })
    gsap.set([hProblem].filter(Boolean), { opacity: 0 })
    gsap.set([hSolution].filter(Boolean), { opacity: 1, xPercent: -50, y: 0 })
    gsap.set([solutionCard].filter(Boolean), { opacity: 1, xPercent: -50, yPercent: -50, scale: 1 })
    return unpin
  })

  mm.add(`${STAGED} and ${MOTION}`, () => {
    let ctx: gsap.Context | null = null

    const build = () => {
      ctx?.revert()
      ctx = gsap.context(() => {
        sizePins()
        const n = fragEls.length || 1
        const tl = gsap.timeline({
          defaults: { ease: 'settle' },
          scrollTrigger: {
            trigger: wrap,
            start: 'top top',
            end: 'bottom bottom',
            scrub: 0.4,
            onToggle: (self) => setNavHidden(self.isActive),
          },
        })

        // The score, in fractions of the runway. Every stretch of scrolling
        // moves something: the fragments drift in (0–0.35), the problem gives
        // way (0.30–0.40) to the answer (0.38–0.50), the hub pulls the
        // fragments into place (0.40–0.70) and wires them (0.60–0.85), and the
        // finished hub holds for the last 0.15 so it can be read.
        fragEls.forEach((f, i) => {
          if (!f.fits) return
          tl.fromTo(
            f.el,
            { opacity: 0, x: f.sx + f.dx * 4, y: f.sy + f.dy * 4, rotation: f.rot, scale: 0.85 },
            { opacity: 1, x: f.sx, y: f.sy, scale: 1, duration: 0.15 },
            (i / n) * 0.2
          ).to(
            f.el,
            { x: f.tx, y: f.ty, rotation: 0, duration: 0.18, ease: 'draft' },
            0.4 + (i / n) * 0.12
          )
        })

        if (hProblem) tl.to(hProblem, { opacity: 0, y: -TRAVEL.md, duration: 0.1 }, 0.3)
        if (hSolution) {
          tl.fromTo(
            hSolution,
            { opacity: 0, xPercent: -50, y: TRAVEL.md },
            { opacity: 1, y: 0, duration: 0.1 },
            0.38
          )
        }
        if (solutionCard) {
          tl.fromTo(
            solutionCard,
            { opacity: 0, xPercent: -50, yPercent: -50, scale: 0.8 },
            { opacity: 1, scale: 1, duration: 0.1 },
            0.4
          )
        }
        const allWires = wireEls
        const allPorts = portEls
        if (allWires?.length && allPorts) {
          // Each wire draws out of the hub and its port lands as it arrives.
          const wires = drawOrder.map((i) => allWires[i])
          const ports = drawOrder.map((i) => allPorts[i])
          const stagger = wires.length > 1 ? 0.13 / (wires.length - 1) : 0
          tl.fromTo(wires, { drawSVG: 0 }, { drawSVG: '100%', duration: 0.12, ease: 'draft', stagger }, 0.6)
          tl.fromTo(ports, { opacity: 0 }, { opacity: 1, duration: 0.02, stagger }, 0.7)
        }
        // The hold: nothing moves, the runway just ends.
        tl.to({}, { duration: 0.15 }, 0.85)
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
      unpin()
      // The transform and the opacity belong to GSAP and come back with the
      // revert; `inert` and `aria-hidden` were set by hand and do not. Turning
      // on reduced motion while the story holds the navigation hidden would
      // otherwise leave a bar that looks perfectly normal and cannot be reached
      // by keyboard or screen reader.
      if (nav) {
        navHidden = false
        nav.removeAttribute('inert')
        nav.removeAttribute('aria-hidden')
        gsap.set(nav, { y: '0%', opacity: 1 })
      }
    }
  })
}

/**
 * The phone and tablet hub: the story's nodes as a grid around one card, wired
 * to it.
 *
 * The wires are laid from the measured cells, like the desktop ring's, so a
 * cell that wraps to another row takes its wire with it. Each one leaves the
 * edge of its node that faces the hub and lands on the hub's facing edge,
 * pulled in towards its centre so the lines converge. Cells are opaque and sit
 * over the wires, so a wire from an outer row reads as running under the cells
 * between — a net, not a tangle.
 *
 * It plays once, as it comes into view: nodes arrive, the hub settles, then the
 * wires draw in. Nothing is scrubbed and nothing holds the scroll.
 */
function initHubGrid() {
  const hub = document.querySelector<HTMLElement>('[data-hub]')
  const core = hub?.querySelector<HTMLElement>('[data-hub-core]')
  const svg = hub?.querySelector<SVGSVGElement>('[data-hub-links]')
  if (!hub || !core || !svg) return
  const nodes = Array.from(hub.querySelectorAll<HTMLElement>('[data-hub-node]'))
  const NS = 'http://www.w3.org/2000/svg'
  const paths = nodes.map(() => {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('fill', 'none')
    p.setAttribute('stroke', '#a4b47a')
    p.setAttribute('stroke-width', '1.2')
    p.setAttribute('stroke-opacity', '0.5')
    svg.appendChild(p)
    return p
  })

  const lay = () => {
    const hb = hub.getBoundingClientRect()
    if (!hb.width) return
    const cb = core.getBoundingClientRect()
    const cx = cb.left + cb.width / 2 - hb.left
    svg.setAttribute('viewBox', `0 0 ${hb.width} ${hb.height}`)
    nodes.forEach((n, i) => {
      const r = n.getBoundingClientRect()
      const nx = r.left + r.width / 2 - hb.left
      const above = r.bottom <= cb.top
      const ny = (above ? r.bottom : r.top) - hb.top
      const ty = (above ? cb.top : cb.bottom) - hb.top
      const tx = cx + (nx - cx) * 0.45
      const my = (ny + ty) / 2
      paths[i].setAttribute('d', `M${nx},${ny} C${nx},${my} ${tx},${my} ${tx},${ty}`)
    })
  }
  lay()
  if ('ResizeObserver' in window) new ResizeObserver(lay).observe(hub)
  document.fonts?.ready.then(lay)

  gsap.matchMedia().add(`(max-width: 1023.98px) and ${MOTION}`, () => {
    // Already on screen at load: leave it be rather than blank it and replay.
    if (hub.getBoundingClientRect().top < window.innerHeight * 0.85) return
    gsap.set(nodes, { autoAlpha: 0, y: TRAVEL.sm })
    gsap.set(core, { autoAlpha: 0 })
    gsap.set(paths, { drawSVG: 0 })
    gsap
      .timeline({
        defaults: { ease: 'settle' },
        scrollTrigger: { trigger: hub, start: 'top 80%', once: true },
      })
      .to(nodes, { autoAlpha: 1, y: 0, duration: sec('slow'), stagger: staggerFor(nodes.length) / 1000 })
      .to(core, { autoAlpha: 1, duration: sec('slow') }, '-=0.3')
      .to(paths, { drawSVG: '100%', duration: sec('slow'), ease: 'draft' }, '-=0.2')
  })
}

initHeroCta()
initAura()
initPins()
initHubGrid()
initReveals()
initSheetIndex()
initChain()
initRoi()
