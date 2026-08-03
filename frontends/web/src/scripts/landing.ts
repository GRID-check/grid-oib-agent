import { initReveals } from './reveal'

const QUESTION =
  'Ich will das Stiegenhaus ins Freie führen und über eine gedämmte Loggia-Fassade erschließen. Was heißt das brandschutztechnisch?'
const TYPE = 1900
const RATE = 1.18
const LOOP = 13600

const KEYS = [
  { t: 0, x: 180, y: 60, z: 0.98 },
  { t: 1500, x: 180, y: 60, z: 0.98 },
  { t: 2100, x: 240, y: 140, z: 0.94 },
  { t: 2700, x: 300, y: 220, z: 0.92 },
  { t: 3300, x: 320, y: 320, z: 0.9 },
  { t: 3900, x: 300, y: 230, z: 0.76 },
  { t: 4000, x: 300, y: 230, z: 0.76 },
  { t: 5300, x: 930, y: 255, z: 0.92 },
  { t: 6200, x: 935, y: 330, z: 0.9 },
  { t: 7000, x: 1000, y: 540, z: 0.86 },
  { t: 7800, x: 1000, y: 540, z: 0.86 },
  { t: 9300, x: 560, y: 300, z: 0.42 },
  { t: 11000, x: 560, y: 300, z: 0.42 },
]

const BEATS = [
  { t: 0, step: 0, label: 'Frage aufgenommen' },
  { t: 400, step: 1, label: 'Quellen werden gesichtet' },
  { t: 1500, step: 2, label: 'Quellen werden gezogen' },
  { t: 2700, step: 3, label: 'Baurecht wird geprüft' },
  { t: 3300, step: 4, label: 'Projektakt wird geprüft' },
  { t: 3900, step: 5, label: 'Alle Quellen geprüft' },
  { t: 4000, step: 6, label: 'Ergebnisse werden zusammengeführt' },
  { t: 5300, step: 7, label: 'Entscheidung — drei Wege' },
  { t: 6150, step: 8, label: 'Option B gewählt' },
  { t: 6950, step: 9, label: 'Umsetzung abgeleitet' },
  { t: 9300, step: 10, label: 'Vollständige Kette' },
]

const clamp = (v: number) => Math.max(0, Math.min(1, v))
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

function initHeroCta() {
  const cta = document.querySelector<HTMLElement>('[data-hero-cta]')
  if (!cta) return
  const apply = () => {
    const on = window.scrollY > window.innerHeight * 0.12
    cta.style.opacity = on ? '0' : '1'
    cta.style.transform = on ? 'translateY(-10px)' : 'translateY(0)'
    cta.style.pointerEvents = on ? 'none' : 'auto'
  }
  apply()
  window.addEventListener('scroll', apply, { passive: true })
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

  const NODES: { r: number; a: number; v: number; label?: string | string[] }[] = [
    { r: 96, a: 0.4, v: 0.045, label: 'OIB-RL 2' },
    { r: 138, a: 2.1, v: -0.032 },
    { r: 118, a: 3.6, v: 0.052, label: 'U-WERT' },
    { r: 176, a: 5.0, v: -0.026 },
    { r: 150, a: 1.2, v: 0.038, label: 'BUDGET' },
    { r: 208, a: 4.1, v: 0.021 },
    { r: 104, a: 5.6, v: -0.058 },
    { r: 190, a: 2.7, v: -0.019, label: 'BO WIEN' },
    { r: 232, a: 0.9, v: 0.016 },
    { r: 128, a: 4.6, v: 0.029 },
    { r: 214, a: 3.2, v: 0.024, label: ['PROJEKTARCHIV', 'VS Aspern 2019', 'Anschlussdetail'] },
    { r: 166, a: 6.0, v: -0.036, label: ['PROJEKTARCHIV', 'Wohnbau Ottakring', 'Fassadenschnitt'] },
  ]
  const BEAMS: [number, number][] = [
    [600, 330],
    [792, 318],
    [648, 424],
    [742, 400],
    [700, 372],
  ]

  const draw = (t: number) => {
    requestAnimationFrame(draw)
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
      if (n.label) {
        const lines = Array.isArray(n.label) ? n.label : [n.label]
        const lh = 11.5 * Math.max(1, sc * 0.75)
        lines.forEach((ln, li) => {
          ctx.fillStyle = `rgba(88,104,64,${((li === 0 ? 0.35 : 0.24) + 0.35 * glow).toFixed(3)})`
          ctx.fillText(ln, nx + 7 * sc, ny - 5 * sc + li * lh)
        })
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
  requestAnimationFrame(draw)
}

interface Frag {
  el: HTMLElement
  dx: number
  dy: number
  fx: number
  fy: number
  hx: number
  hy: number
  tx: number
  ty: number
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
      const [fx, fy] = (el.getAttribute('data-target') ?? '0.5,0.5').split(',').map(Number)
      el.style.willChange = 'transform, opacity'
      el.style.opacity = '0'
      return { el, dx, dy, fx, fy, hx: 0, hy: 0, tx: 0, ty: 0 }
    }
  )

  let lineEls: { el: SVGLineElement; len: number }[] | null = null

  const measureStory = () => {
    const W = panel.clientWidth
    const H = panel.clientHeight
    const ccx = 0.5 * W
    const ccy = 0.57 * H
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
    fragEls.forEach((f, i) => {
      f.hx = f.el.offsetLeft + f.el.offsetWidth / 2
      f.hy = f.el.offsetTop + f.el.offsetHeight / 2
      f.tx = f.fx * W - f.hx
      f.ty = f.fy * H - f.hy
      if (lineEls) {
        const l = lineEls[i]
        l.el.setAttribute('x1', String(ccx))
        l.el.setAttribute('y1', String(ccy))
        l.el.setAttribute('x2', String(f.fx * W))
        l.el.setAttribute('y2', String(f.fy * H))
        l.len = Math.hypot(f.fx * W - ccx, f.fy * H - ccy)
        l.el.style.strokeDasharray = String(l.len)
      }
    })
  }

  const setStatic = () => {
    fragEls.forEach((f) => {
      f.el.style.opacity = '1'
      f.el.style.transform = `translate(${f.tx}px,${f.ty}px)`
    })
    if (hProblem) hProblem.style.opacity = '0'
    if (hSolution) hSolution.style.opacity = '1'
    if (solutionCard) {
      solutionCard.style.opacity = '1'
      solutionCard.style.transform = 'translate(-50%,-50%)'
    }
    lineEls?.forEach((l) => {
      l.el.style.strokeDashoffset = '0'
      l.el.style.opacity = '0.45'
    })
  }

  if (reduced) {
    measureStory()
    setStatic()
    return
  }

  wrap.style.height = '440vh'
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
  }

  const update = () => {
    const vh = window.innerHeight
    const r = wrap.getBoundingClientRect()
    if (nav) {
      const hide = r.top < vh * 0.4 && r.bottom > vh * 0.5
      nav.style.transform = hide ? 'translateY(-110%)' : 'translateY(0)'
      nav.style.opacity = hide ? '0' : '1'
    }
    const total = r.height - vh
    const p = clamp(-r.top / total)
    const n = fragEls.length
    fragEls.forEach((f, i) => {
      const inStart = 0.03 + (i / n) * 0.27
      const eIn = easeOut(clamp((p - inStart) / 0.16))
      const orgStart = 0.5 + (i / n) * 0.16
      const eOrg = easeOut(clamp((p - orgStart) / 0.24))
      const tx = f.dx * 4 * (1 - eIn) + f.tx * eOrg
      const ty = f.dy * 4 * (1 - eIn) + f.ty * eOrg
      const sc = (0.85 + 0.15 * eIn) * (1 - 0.16 * eOrg)
      f.el.style.opacity = String(eIn)
      f.el.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`
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
  let rafPending = false
  window.addEventListener(
    'scroll',
    () => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        update()
      })
    },
    { passive: true }
  )
  setTimeout(() => {
    measureStory()
    update()
  }, 700)
  update()
}

function camAt(ms: number) {
  const K = KEYS
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
  return { x: axis(a.x, b.x, c.x, d.x), y: axis(a.y, b.y, c.y, d.y), z: axis(a.z, b.z, c.z, d.z) }
}

function initChain() {
  const anchor = document.querySelector<HTMLElement>('[data-chat-anchor]')
  const stage = anchor?.querySelector<HTMLElement>('[data-stage]')
  const camEl = anchor?.querySelector<HTMLElement>('[data-cam]')
  const qEl = anchor?.querySelector<HTMLElement>('[data-q-text]')
  const caretEl = anchor?.querySelector<HTMLElement>('[data-q-caret]')
  const statusEl = anchor?.querySelector<HTMLElement>('[data-status]')
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

  if (reduced) {
    setStep(10)
    setCam(KEYS[KEYS.length - 1])
    if (statusEl) statusEl.textContent = 'Vollständige Kette'
    return
  }

  let startedAt: number | null = null
  let raf = 0
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick)
    if (startedAt == null) return
    let raw = (now - startedAt) * RATE
    if (raw > LOOP) {
      startedAt = now
      raw = 0
    }
    const p = Math.min(1, raw / (TYPE - 350))
    const n = Math.round(QUESTION.length * p)
    const txt = QUESTION.slice(0, n)
    if (qEl.textContent !== txt) qEl.textContent = txt
    if (caretEl) caretEl.style.display = p < 1 ? 'inline-block' : 'none'
    if (raw < TYPE) {
      if (statusEl.textContent !== 'Frage wird eingegeben')
        statusEl.textContent = 'Frage wird eingegeben'
      setStep(0)
      setCam(KEYS[0])
      return
    }
    const ms = raw - TYPE
    setCam(camAt(ms))
    let bi = 0
    for (let i = 0; i < BEATS.length; i++) if (ms >= BEATS[i].t) bi = i
    const beat = BEATS[bi]
    setStep(beat.step)
    if (statusEl.textContent !== beat.label) statusEl.textContent = beat.label
  }

  const start = () => {
    startedAt = performance.now()
    if (!raf) raf = requestAnimationFrame(tick)
  }

  anchor.querySelector('[data-replay]')?.addEventListener('click', () => {
    startedAt = performance.now()
  })

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && !raf) {
          io.disconnect()
          start()
        }
      })
    },
    { threshold: 0.35 }
  )
  io.observe(anchor)
}

initHeroCta()
initAura()
initPins()
initReveals()
initChain()
