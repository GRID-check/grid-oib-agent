export function initNav() {
  const header = document.querySelector<HTMLElement>('[data-nav]')
  const bar = document.querySelector<HTMLElement>('[data-nav-bar]')
  if (!header || !bar) return
  const heroWrap = document.querySelector<HTMLElement>('[data-hero-wrap]')
  let heroHeight = heroWrap?.offsetHeight ?? 0
  const refresh = () => {
    heroHeight = heroWrap?.offsetHeight ?? 0
    apply()
  }
  window.addEventListener('resize', refresh)
  if (heroWrap && 'ResizeObserver' in window) new ResizeObserver(refresh).observe(heroWrap)
  let overHero: boolean | null = null
  function apply() {
    const barEl = bar
    if (!barEl) return
    const next = heroWrap ? window.scrollY < heroHeight - 70 : false
    if (next === overHero) return
    overHero = next
    barEl.classList.toggle('bg-canvas/95', !next)
    barEl.classList.toggle('shadow-[0_1px_0_rgb(31_32_35/0.08)]', !next)
    barEl.classList.toggle('backdrop-blur-sm', !next)
  }
  apply()
  window.addEventListener('scroll', apply, { passive: true })
  initScrollSpy(bar)
}

/**
 * Marks the anchor whose section owns the viewport with `aria-current="true"`.
 *
 * Deliberately the same rule the margin sheet-index uses — whichever section
 * crosses the middle of the viewport is the current one — so the two indicators
 * can never disagree. A rect test on scroll rather than an IntersectionObserver:
 * several sections are taller than the viewport, pinned or snap-centred, so
 * "is intersecting" holds for two of them at once and the thresholds needed to
 * break that tie come out as this comparison anyway.
 */
function initScrollSpy(bar: HTMLElement) {
  const links = new Map<string, HTMLAnchorElement>()
  for (const a of bar.querySelectorAll<HTMLAnchorElement>('[data-nav-link]')) {
    const id = a.dataset.navLink
    if (id) links.set(id, a)
  }

  const targets = [...links.keys()]
    .map((id) => ({ id, el: document.getElementById(id) }))
    .filter((t): t is { id: string; el: HTMLElement } => t.el !== null)
  // Off the landing page the anchors point into another document — nothing to spy on.
  if (!targets.length) return

  let current: string | null = null
  const apply = () => {
    const mid = window.innerHeight / 2
    const next =
      targets.find((t) => {
        const r = t.el.getBoundingClientRect()
        return r.top <= mid && r.bottom >= mid
      })?.id ?? null
    if (next === current) return
    if (current) links.get(current)?.removeAttribute('aria-current')
    if (next) links.get(next)?.setAttribute('aria-current', 'location')
    current = next
  }
  apply()
  window.addEventListener('scroll', apply, { passive: true })
  window.addEventListener('resize', apply)
}
