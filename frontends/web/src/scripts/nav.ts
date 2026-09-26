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
    // sheet hangs from nothing over the photograph.
    const overHero = heroWrap ? window.scrollY < heroHeight - 70 : false
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
}

/**
 * The phone menu: a disclosure, not a dialog. The page behind stays where it
 * is and reachable; the sheet closes on Escape (focus back to the button), on
 * a tap outside, on following one of its links, when focus leaves the header,
 * and when the window grows past the breakpoint that hides the button.
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
    sheet.hidden = !next
    if (scrim) scrim.hidden = !next
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
