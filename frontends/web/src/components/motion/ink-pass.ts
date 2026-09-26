import { DURATION, STAGGER, TRAVEL, cssEase, reducedMotion } from '../../lib/motion'

/**
 * The ink pass: a riso print arrives the way a riso prints it, one ink at a
 * time. Each ink is laid down by a drum passing over the sheet from top to
 * bottom (a clip wipe), lands a hair out of register and settles into it.
 * When the last ink has settled, the layers are removed and the untouched
 * print is shown, so at rest the page holds exactly the file on disk, at its
 * own pixel size, with no transform on it.
 *
 * Two sources for the inks:
 *
 * - **Separations** (`data-inks="mist,kelly,moss,hunter"`): one transparent
 *   file per ink beside the print (`<file>-<ink>.webp`) and its paper
 *   (`<file>-paper.webp`), exported by the riso kit. Multiplied over the paper
 *   they are the print, so the pass is the real one.
 * - **Bands** (no separations on disk): the print itself, split by an SVG
 *   filter into a pale ground ink and a middle ink by how dark each pixel is,
 *   then the whole print as the key pass. An approximation: every ink on these
 *   plates is a green, so there is no hue to separate them by, but the light
 *   ink really is printed first and the key really is printed last.
 *
 * Once per element, only when it is on screen, only after any page transition
 * has landed, and never under `prefers-reduced-motion`. Opacity, transform and
 * clip-path only.
 */

/** Print order: the lightest ink first, the key last. */
const ORDER = ['mist', 'kelly', 'moss', 'red', 'hunter'] as const
type Ink = (typeof ORDER)[number]

/** The drum colours (art/riso/tafeln/index.html, INK). */
const INK: Record<Ink, string> = {
  mist: '#D5E4C0',
  kelly: '#67B346',
  moss: '#68724D',
  hunter: '#407060',
  red: '#F15060',
}
const PAPER = '#F4F2E8'

/**
 * Where each pass lands before it settles, as multiples of `TRAVEL.hair`.
 * Mostly along the feed (vertical), as a real drum slips; the key is laid
 * nearly true, because the others register to it.
 */
const MISS: Record<Ink | 'band-1' | 'band-2' | 'key', [number, number]> = {
  mist: [0.7, -1],
  kelly: [-0.7, 1],
  moss: [0.5, 1],
  red: [-1, 0.5],
  hunter: [0, -0.35],
  'band-1': [0.7, -1],
  'band-2': [-0.6, 1],
  key: [0, -0.35],
}

/** Time between one drum starting and the next. */
const PASS_GAP = STAGGER.step * 2.5

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The two band filters, added to the page once. */
function ensureBandFilters() {
  if (document.getElementById('ink-pass-filters')) return
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.id = 'ink-pass-filters'
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  // alpha = k·((1 − luminance) − t): how far a pixel is darker than the
  // threshold, steeply, so the band reads as a flat ink, halftone dots intact.
  const band = (id: string, hex: string, t: number, k: number) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const f = document.createElementNS(SVG_NS, 'filter')
    f.id = id
    f.setAttribute('color-interpolation-filters', 'sRGB')
    const m = document.createElementNS(SVG_NS, 'feColorMatrix')
    m.setAttribute('type', 'matrix')
    m.setAttribute(
      'values',
      [
        [0, 0, 0, 0, r],
        [0, 0, 0, 0, g],
        [0, 0, 0, 0, b],
        [-k * 0.2126, -k * 0.7152, -k * 0.0722, 0, k * (1 - t)],
      ]
        .map((row) => row.map((v) => +v.toFixed(4)).join(' '))
        .join(' ')
    )
    f.appendChild(m)
    svg.appendChild(f)
  }
  band('ink-pass-band-1', INK.mist, 0.1, 5)
  band('ink-pass-band-2', INK.moss, 0.34, 3)
  document.body.appendChild(svg)
}

interface Pass {
  el: HTMLElement
  miss: [number, number]
}

function layer(img: HTMLImageElement, src: string, css: Partial<CSSStyleDeclaration>) {
  const el = document.createElement('img')
  el.src = src
  el.alt = ''
  el.decoding = 'async'
  el.setAttribute('aria-hidden', 'true')
  el.className = 'ink-pass__layer'
  el.width = img.width
  el.height = img.height
  Object.assign(el.style, css)
  return el
}

/** Build the layers for one print. Resolves once every layer has decoded. */
async function build(root: HTMLElement, img: HTMLImageElement) {
  const src = img.currentSrc || img.src
  const inks = (root.dataset.inks ?? '')
    .split(',')
    .filter((i): i is Ink => (ORDER as readonly string[]).includes(i))
  const stage = document.createElement('div')
  stage.className = 'ink-pass__stage'
  stage.setAttribute('aria-hidden', 'true')

  const passes: Pass[] = []
  if (inks.length) {
    const base = src.replace(/\.webp$/, '')
    stage.appendChild(layer(img, `${base}-paper.webp`, {}))
    for (const ink of ORDER.filter((i) => inks.includes(i))) {
      const el = layer(img, `${base}-${ink}.webp`, { mixBlendMode: 'multiply' })
      passes.push({ el, miss: MISS[ink] })
    }
  } else {
    ensureBandFilters()
    stage.style.background = PAPER
    passes.push(
      { el: layer(img, src, { filter: 'url(#ink-pass-band-1)', mixBlendMode: 'multiply' }), miss: MISS['band-1'] },
      { el: layer(img, src, { filter: 'url(#ink-pass-band-2)', mixBlendMode: 'multiply' }), miss: MISS['band-2'] },
      { el: layer(img, src, {}), miss: MISS.key }
    )
  }
  for (const p of passes) {
    p.el.style.clipPath = 'inset(0 0 100% 0)'
    stage.appendChild(p.el)
  }
  root.appendChild(stage)
  await Promise.all(Array.from(stage.querySelectorAll('img')).map((i) => i.decode().catch(() => {})))
  return { stage, passes }
}

/** Snap a CSS px offset to whole device pixels. */
const snap = (v: number) => Math.round(v * devicePixelRatio) / devicePixelRatio

async function play(root: HTMLElement, img: HTMLImageElement) {
  await (window as Window & { __pageSettled?: Promise<unknown> }).__pageSettled
  const { stage, passes } = await build(root, img)
  root.classList.add('ink-pass--printing')

  const runs = passes.map((p, i) => {
    const delay = i * PASS_GAP
    const [mx, my] = p.miss.map((m) => snap(m * TRAVEL.hair))
    // The drum: the ink appears from the top edge down, as the sheet feeds.
    const wipe = p.el.animate(
      [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)' }],
      { duration: DURATION.draw, delay, easing: cssEase('draft'), fill: 'both' }
    )
    // Registration: laid a hair off, drawn into register.
    const reg = p.el.animate(
      [{ transform: `translate(${mx}px, ${my}px)` }, { transform: 'translate(0, 0)' }],
      { duration: DURATION.slow, delay: delay + DURATION.quick, easing: cssEase('settle'), fill: 'both' }
    )
    return Promise.all([wipe.finished, reg.finished])
  })
  await Promise.all(runs).catch(() => {})
  root.classList.remove('ink-pass--printing')
  root.classList.add('ink-pass--done')
  stage.remove()
}

function arm() {
  if (reducedMotion() || !('IntersectionObserver' in window)) return
  const roots = document.querySelectorAll<HTMLElement>('[data-ink-pass]:not(.ink-pass--armed)')
  if (!roots.length) return
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        io.unobserve(e.target)
        const root = e.target as HTMLElement
        const img = root.querySelector<HTMLImageElement>(':scope > img')
        if (!img) continue
        const done = () => root.classList.add('ink-pass--done')
        const go = () => play(root, img).catch(done)
        if (img.complete) go()
        else {
          img.addEventListener('load', go, { once: true })
          img.addEventListener('error', done, { once: true })
        }
      }
    },
    { threshold: 0.35 }
  )
  roots.forEach((root) => {
    root.classList.add('ink-pass--armed')
    io.observe(root)
  })
}

// Registered once per page however many prints import it.
arm()
