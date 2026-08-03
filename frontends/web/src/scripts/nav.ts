export function initNav() {
  const header = document.querySelector<HTMLElement>('[data-nav]')
  const bar = document.querySelector<HTMLElement>('[data-nav-bar]')
  if (!header || !bar) return
  const heroWrap = document.querySelector<HTMLElement>('[data-hero-wrap]')
  const apply = () => {
    const overHero = heroWrap ? window.scrollY < heroWrap.offsetHeight - 70 : false
    bar.classList.toggle('bg-canvas/95', !overHero)
    bar.classList.toggle('shadow-[0_1px_0_rgb(31_32_35/0.08)]', !overHero)
    bar.classList.toggle('backdrop-blur-sm', !overHero)
  }
  apply()
  window.addEventListener('scroll', apply, { passive: true })
}
