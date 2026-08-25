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
    // Over the hero the bar is invisible chrome; past it, it condenses into a
    // glass rail — narrower, ringed with a hairline, lifted a hair off the page.
    barEl.classList.toggle('bg-canvas/70', !next)
    barEl.classList.toggle('backdrop-blur-xl', !next)
    barEl.classList.toggle('ring-1', !next)
    barEl.classList.toggle('ring-ink/8', !next)
    barEl.classList.toggle('shadow-card', !next)
    barEl.classList.toggle('max-w-[68rem]', !next)
    barEl.classList.toggle('rounded-full', !next)
  }
  apply()
  window.addEventListener('scroll', apply, { passive: true })
}
