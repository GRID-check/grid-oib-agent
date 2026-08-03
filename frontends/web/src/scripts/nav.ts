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
}
