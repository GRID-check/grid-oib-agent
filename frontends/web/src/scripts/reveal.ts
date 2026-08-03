export function initReveals() {
  if (!('IntersectionObserver' in window)) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
  els.forEach((el) => {
    if (el.getBoundingClientRect().top > window.innerHeight * 0.92) {
      el.style.opacity = '0'
      el.style.transform = 'translateY(26px)'
    }
  })
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          const t = e.target as HTMLElement
          t.style.opacity = '1'
          t.style.transform = 'translateY(0)'
          io.unobserve(t)
        }
      })
    },
    { threshold: 0.12 }
  )
  els.forEach((el) => io.observe(el))
}
