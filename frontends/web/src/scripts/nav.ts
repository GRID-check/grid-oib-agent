import { DURATION, TRAVEL, cssEase, reducedMotion } from '../lib/motion'

/** The classes that turn the invisible bar over the hero into the glass rail. */
const RAIL = ['bg-canvas/70', 'backdrop-blur-xl', 'ring-1', 'ring-ink/8', 'shadow-card', 'max-w-[68rem]', 'rounded-full']

export function initNav() {
  const header = document.querySelector<HTMLElement>('[data-nav]')
  const bar = document.querySelector<HTMLElement>('[data-nav-bar]')
  if (!header || !bar) return
  const menu = initMenu(header)

  const heroWrap = document.querySelector<HTMLElement>('[data-hero-wrap]')
  let heroHeight = heroWrap?.offsetHeight ?? 0
  let rail: boolean | null = null
  function apply() {
    // Over the hero the bar is invisible chrome; past it, or with the menu
    // open, it condenses into a glass rail — narrower, ringed with a hairline,
    // lifted a hair off the page. An open menu needs the bar solid, or the
    // sheet hangs from nothing over the photograph. It condenses once the
    // hero is 60% gone: by then the headline has faded (landing.ts), and
    // nothing of the hero is left to print through the logo.
    const overHero = heroWrap ? window.scrollY < heroHeight * 0.6 : false
    const next = !overHero || menu.isOpen()
    if (next === rail) return
    rail = next
    RAIL.forEach((c) => bar!.classList.toggle(c, next))
  }
  const refresh = () => {
    heroHeight = heroWrap?.offsetHeight ?? 0
    apply()
  }
  window.addEventListener('resize', refresh)
  if (heroWrap && 'ResizeObserver' in window) new ResizeObserver(refresh).observe(heroWrap)
  menu.onChange(apply)
  apply()
  window.addEventListener('scroll', apply, { passive: true })
  initTone(bar)
}

/**
 * The rail takes the tone of the sheet under it. Glass over a dark panel is a
 * grey slab with dark text on it; over a dark sheet the rail turns dark too
 * (the styles are in global.css, `[data-nav-bar][data-tone='dark']`).
 *
 * A dark sheet is anything marked `data-tone="dark"`, or drawn with the dark
 * sheet grid (`.sheet-dark`), so a new dark panel is covered without a second
 * list. An IntersectionObserver watches a one-pixel line through the middle of
 * the bar, so nothing is measured on scroll.
 */
function initTone(bar: HTMLElement) {
  const sheets = Array.from(document.querySelectorAll<HTMLElement>('[data-tone="dark"], .sheet-dark'))
  if (!sheets.length || !('IntersectionObserver' in window)) return
  const under = new Set<Element>()
  let io: IntersectionObserver | null = null
  const watch = () => {
    io?.disconnect()
    under.clear()
    const line = Math.round(bar.getBoundingClientRect().top + bar.offsetHeight / 2)
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) under.add(e.target)
          else under.delete(e.target)
        }
        if (under.size) bar.dataset.tone = 'dark'
        else delete bar.dataset.tone
      },
      { rootMargin: `-${line}px 0px -${Math.max(0, window.innerHeight - line - 1)}px 0px` }
    )
    sheets.forEach((s) => io!.observe(s))
  }
  watch()
  let t = 0
  window.addEventListener('resize', () => {
    window.clearTimeout(t)
    t = window.setTimeout(watch, 150)
  })
}

const running = new WeakMap<HTMLElement, Animation>()

/**
 * Shows or hides an element with the `hidden` attribute, and moves it: in
 * over `quick`, out over `tick`, both on `settle`, so closing is faster
 * than opening. `hidden` is set only once the way out has finished, and a
 * reversal mid-way starts from where the element is.
 */
function show(el: HTMLElement, on: boolean, dy: number) {
  running.get(el)?.cancel()
  if (on) el.hidden = false
  if (reducedMotion() || !el.animate) {
    el.hidden = !on
    return
  }
  const shut = { opacity: 0, transform: `translateY(${dy}px)` }
  const opened = { opacity: 1, transform: 'translateY(0)' }
  const a = el.animate(on ? [shut, opened] : [opened, shut], {
    duration: on ? DURATION.quick : DURATION.tick,
    easing: cssEase('settle'),
  })
  running.set(el, a)
  a.finished.then(
    () => {
      if (!on) el.hidden = true
      running.delete(el)
    },
    () => {}
  )
}

/**
 * The phone menu: a disclosure, not a dialog. The sheet closes on Escape
 * (focus back to the button), on a tap outside, on following one of its
 * links, when focus leaves the header, and when the window grows past the
 * breakpoint that hides the button. While it is open the page behind does not
 * scroll.
 */
function initMenu(header: HTMLElement) {
  const toggle = header.querySelector<HTMLButtonElement>('[data-nav-toggle]')
  const sheet = header.querySelector<HTMLElement>('[data-nav-menu]')
  const scrim = header.querySelector<HTMLElement>('[data-nav-scrim]')
  const listeners: (() => void)[] = []
  let open = false
  const api = { isOpen: () => open, onChange: (fn: () => void) => listeners.push(fn) }
  if (!toggle || !sheet) return api

  const setOpen = (next: boolean, returnFocus = false) => {
    if (next === open) return
    open = next
    toggle.setAttribute('aria-expanded', String(next))
    toggle.setAttribute('aria-label', (next ? toggle.dataset.labelClose : toggle.dataset.labelOpen) ?? '')
    show(sheet, next, -TRAVEL.sm)
    if (scrim) show(scrim, next, 0)
    // The scrim says the page behind is out of play, so it holds still: the
    // page used to scroll on under the open sheet.
    document.documentElement.style.overflow = next ? 'hidden' : ''
    if (next) sheet.querySelector<HTMLElement>('a[href]')?.focus({ preventScroll: true })
    else if (returnFocus) toggle.focus()
    listeners.forEach((fn) => fn())
  }

  toggle.addEventListener('click', () => setOpen(!open))
  scrim?.addEventListener('click', () => setOpen(false))
  // Following a link closes the sheet: on a same-page anchor the page scrolls
  // underneath, and the sheet would otherwise stay parked over the target.
  // Sign-in is the exception: it leaves the site, and its "redirecting" state
  // is only feedback if the sheet stays up to show it.
  sheet.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a:not([data-sign-in])')) setOpen(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) setOpen(false, true)
  })
  header.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null
    if (open && to && !header.contains(to)) setOpen(false)
  })
  const wide = window.matchMedia('(min-width: 1024px)')
  wide.addEventListener('change', (e) => {
    if (e.matches) setOpen(false)
  })
  return api
}
