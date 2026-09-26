/**
 * The decision chain as stories, on phones (components/molecules/ChainStories).
 *
 * This file owns order and time: which frame is on top, how long it stays, and
 * whether the clock runs. The arrival inside a frame is CSS, started by the
 * `is-playing` class and timed by the variables written from `MOTION` below,
 * so the stylesheet and the clock read one table.
 *
 * The clock is the progress segment itself: a Web Animation on the current
 * segment's fill whose `finish` advances the story. Pausing the story pauses
 * that animation. Pressing and holding, or scrolling away, also sets
 * `data-paused`, which freezes every CSS animation in the frame, so a held
 * frame stops where it is rather than running on underneath.
 *
 * It runs only while the card is at least 60% on screen and the tab is
 * visible, and not at all under `prefers-reduced-motion: reduce`: there the
 * frames arrive finished and move only when asked.
 */

/** Every duration and curve in the story. Motion-system tokens replace these. */
const MOTION = {
  /** Entrances: a sheet laid down, no overshoot. */
  ease: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
  /** State changes: a flip, a dim, a check. */
  state: 'cubic-bezier(0.4, 0, 0.2, 1)',
  /** One sheet replacing another: short, a slide and a fade, nothing more. */
  sheetIn: 320,
  sheetOut: 240,
  /** What arrives inside a frame. */
  enter: 420,
  quick: 240,
  stagger: 70,
  /** Delay before a frame's own arrival begins, after the sheet has landed. */
  lead: 200,
  markAt: 900,
  checkAt: 600,
  checkGap: 240,
  doneAt: 1500,
  /** How far the sheets travel, as a share of the card width. */
  slideIn: 12,
  slideOut: 4,
  /** Time to read each frame once its arrival is done. */
  hold: [3800, 4400, 3800, 3400],
  /** Visibility share of the card that counts as "being watched". */
  inView: 0.6,
  /** Press this long and the story holds. */
  holdAfter: 220,
  /** Sideways travel that turns a drag into a swipe. */
  swipe: 44,
} as const

const ms = (v: number) => `${v}ms`

/** How long frame `i` stays before the clock moves on. */
function dwell(i: number): number {
  const arrival = [
    MOTION.lead + MOTION.enter,
    MOTION.lead + 3 * MOTION.stagger + MOTION.enter,
    MOTION.markAt + MOTION.enter,
    MOTION.doneAt + 180 + MOTION.enter,
  ][i]
  return (arrival ?? 0) + (MOTION.hold[i] ?? 3000)
}

export function initChainStories() {
  for (const root of document.querySelectorAll<HTMLElement>('[data-stories]:not([data-ready])')) {
    initOne(root)
  }
}

function initOne(root: HTMLElement) {
  const stage = root.querySelector<HTMLElement>('[data-stories-stage]')
  const frames = Array.from(root.querySelectorAll<HTMLElement>('[data-frame]'))
  const fills = Array.from(root.querySelectorAll<HTMLElement>('[data-seg]'))
  const prevBtn = root.querySelector<HTMLButtonElement>('[data-prev]')
  const nextBtn = root.querySelector<HTMLButtonElement>('[data-next]')
  const toggle = root.querySelector<HTMLButtonElement>('[data-toggle]')
  const live = root.querySelector<HTMLElement>('[data-live]')
  const edge = root.querySelector<HTMLButtonElement>('[data-edge]')
  if (!stage || frames.length === 0 || !toggle) return

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const tones = frames.map((f) => (f.classList.contains('frame--paper') ? 'paper' : f.classList.contains('frame--sage') ? 'sage' : 'dark'))
  const last = frames.length - 1

  const vars: Record<string, string> = {
    '--st-ease': MOTION.ease,
    '--st-state': MOTION.state,
    '--st-enter': ms(MOTION.enter),
    '--st-quick': ms(MOTION.quick),
    '--st-stagger': ms(MOTION.stagger),
    '--st-lead': ms(MOTION.lead),
    '--st-mark-at': ms(MOTION.markAt),
    '--st-check-at': ms(MOTION.checkAt),
    '--st-check-gap': ms(MOTION.checkGap),
    '--st-done-at': ms(MOTION.doneAt),
  }
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)

  let current = 0
  let clock: Animation | null = null
  let moving: Animation[] = []
  // Why the story is not running, if it is not. Any one of these holds it.
  const hold = { offscreen: true, hidden: document.hidden, user: false, press: false, detail: false, ended: false }

  const motion = () => !reduced.matches
  const running = () => motion() && !Object.values(hold).some(Boolean)

  function sync() {
    const run = running()
    // The clock stops for any hold; a frame's arrival freezes only while it
    // cannot be watched or is being held down. Paused by the button, the story
    // still lets a frame you step to arrive: it only stops moving on by itself.
    root.toggleAttribute('data-paused', hold.press || hold.offscreen || hold.hidden)
    if (clock) {
      if (run) clock.play()
      else clock.pause()
    }
    const label = hold.ended ? toggle!.dataset.labelReplay : hold.user || !motion() ? toggle!.dataset.labelPlay : toggle!.dataset.labelPause
    toggle!.textContent = label ?? ''
    // Without motion nothing plays on its own; the toggle only replays.
    toggle!.hidden = !motion() && !hold.ended
    if (prevBtn) prevBtn.disabled = current === 0
    if (nextBtn) nextBtn.disabled = current === last
    if (edge) edge.hidden = current === last
  }

  function startClock() {
    clock?.cancel()
    clock = null
    fills.forEach((f, i) => {
      f.style.transform = i < current || (!motion() && i === current) ? 'scaleX(1)' : 'scaleX(0)'
    })
    const fill = fills[current]
    if (!motion() || !fill) return
    clock = fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
      duration: dwell(current),
      fill: 'forwards',
    })
    clock.pause()
    clock.onfinish = () => {
      if (current < last) go(current + 1, false)
      else {
        hold.ended = true
        sync()
      }
    }
  }

  /** Put every flipped card back and close every open reason in a frame. */
  function resetDetail(frame: HTMLElement) {
    frame.querySelectorAll('[data-flip][aria-pressed="true"]').forEach((b) => b.setAttribute('aria-pressed', 'false'))
    frame.querySelectorAll('[data-why][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'))
    hold.detail = false
  }

  function play(frame: HTMLElement) {
    frame.classList.remove('is-playing')
    if (!motion()) return
    void frame.offsetWidth // restart the frame's CSS animations from zero
    frame.classList.add('is-playing')
  }

  function show(i: number) {
    frames.forEach((f, j) => {
      const on = j === i
      f.classList.toggle('is-current', on)
      f.inert = !on
    })
    root.dataset.tone = tones[i]
  }

  function go(to: number, user: boolean) {
    if (to < 0 || to > last) return
    const from = current
    const dir = to >= from ? 1 : -1
    for (const a of moving) a.finish()
    moving = []
    const out = frames[from]!
    const inc = frames[to]!
    if (from !== to) resetDetail(out)
    current = to
    hold.ended = false
    play(inc)
    if (from !== to && motion()) {
      // The outgoing sheet stays visible while it leaves; the incoming one is
      // laid over it from the side of travel.
      out.style.visibility = 'visible'
      inc.style.zIndex = '2'
      moving = [
        out.animate(
          [
            { transform: 'none', opacity: 1 },
            { transform: `translate3d(${-dir * MOTION.slideOut}%,0,0)`, opacity: 0 },
          ],
          { duration: MOTION.sheetOut, easing: MOTION.state },
        ),
        inc.animate(
          [
            { transform: `translate3d(${dir * MOTION.slideIn}%,0,0)`, opacity: 0 },
            { transform: 'none', opacity: 1 },
          ],
          { duration: MOTION.sheetIn, easing: MOTION.ease },
        ),
      ]
      moving[1]!.onfinish = () => {
        out.style.visibility = ''
        inc.style.zIndex = ''
      }
    }
    show(to)
    startClock()
    sync()
    if (user && live) live.textContent = inc.getAttribute('aria-label') ?? ''
  }

  const next = (user: boolean) => (current < last ? go(current + 1, user) : undefined)
  const prev = (user: boolean) => go(Math.max(0, current - 1), user)

  // ── controls ──────────────────────────────────────────────────────────────

  prevBtn?.addEventListener('click', () => prev(true))
  nextBtn?.addEventListener('click', () => next(true))
  toggle.addEventListener('click', () => {
    if (hold.ended || !motion()) {
      go(0, true)
      return
    }
    hold.user = !hold.user
    sync()
  })
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') next(true)
    else if (e.key === 'ArrowLeft') prev(true)
    else return
    e.preventDefault()
  })

  // Taps have one meaning each. The strip at the right edge moves on. A card
  // flips, an option opens its reasoning: the reader asking for a closer look,
  // so the story waits until it is closed. Elsewhere on a frame that holds
  // such content a tap does nothing; on a frame without any, the sheet itself
  // pages (left third back, the rest onward), as stories do.
  stage.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const flip = target.closest<HTMLElement>('[data-flip]')
    const why = target.closest<HTMLElement>('[data-why]')
    if (target.closest('[data-edge]')) {
      next(true)
      return
    }
    if (flip) {
      flip.setAttribute('aria-pressed', String(flip.getAttribute('aria-pressed') !== 'true'))
    } else if (why) {
      const open = why.getAttribute('aria-expanded') !== 'true'
      frames[current]!.querySelectorAll('[data-why]').forEach((b) => b.setAttribute('aria-expanded', 'false'))
      why.setAttribute('aria-expanded', String(open))
    } else {
      if (frames[current]!.querySelector('[data-flip], [data-why]')) return
      const r = stage.getBoundingClientRect()
      if (e.clientX - r.left < r.width / 3) prev(true)
      else next(true)
      return
    }
    hold.detail = !!frames[current]!.querySelector('[aria-pressed="true"], [aria-expanded="true"]')
    sync()
  })

  // ── gestures ──────────────────────────────────────────────────────────────
  // `touch-action: pan-y` leaves vertical scrolling to the browser, which
  // cancels the pointer the moment it starts to scroll. A gesture is ours only
  // once it is clearly sideways; a press that stays put long enough holds.

  let start: { x: number; y: number; id: number } | null = null
  let swiping = false
  let pressTimer = 0
  let swallowClick = false

  const endPress = () => {
    window.clearTimeout(pressTimer)
    if (hold.press) {
      hold.press = false
      sync()
    }
    const cur = frames[current]
    if (swiping && cur) cur.style.transform = ''
    swiping = false
    start = null
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button > 0) return
    start = { x: e.clientX, y: e.clientY, id: e.pointerId }
    swiping = false
    swallowClick = false
    pressTimer = window.setTimeout(() => {
      hold.press = true
      swallowClick = true
      sync()
    }, MOTION.holdAfter)
  })

  stage.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (!swiping) {
      if (Math.abs(dx) + Math.abs(dy) > 8) window.clearTimeout(pressTimer)
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.4) return
      swiping = true
      swallowClick = true
      stage.setPointerCapture(e.pointerId)
    }
    // The sheet follows the finger a little, so the gesture feels held.
    const cur = frames[current]
    if (cur && motion() && moving.length === 0) cur.style.transform = `translate3d(${dx * 0.18}px,0,0)`
  })

  stage.addEventListener('pointerup', (e) => {
    if (!start || e.pointerId !== start.id) return
    const dx = e.clientX - start.x
    const wasSwipe = swiping
    endPress()
    if (!wasSwipe || Math.abs(dx) < MOTION.swipe) return
    if (dx < 0) next(true)
    else prev(true)
  })
  stage.addEventListener('pointercancel', endPress)
  // A swipe or a hold is not also a tap.
  stage.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return
      swallowClick = false
      e.stopPropagation()
      e.preventDefault()
    },
    true,
  )
  stage.addEventListener('contextmenu', (e) => e.preventDefault())

  // ── when to run ───────────────────────────────────────────────────────────

  let started = false
  new IntersectionObserver(
    ([entry]) => {
      hold.offscreen = !entry || entry.intersectionRatio < MOTION.inView
      if (!hold.offscreen && !started) {
        started = true
        go(0, false)
        return
      }
      sync()
    },
    { threshold: [0, MOTION.inView] },
  ).observe(stage)
  document.addEventListener('visibilitychange', () => {
    hold.hidden = document.hidden
    sync()
  })
  reduced.addEventListener('change', () => go(current, false))

  root.dataset.ready = ''
  show(0)
  play(frames[0]!)
  startClock()
  sync()
}
