import { inView } from 'motion'

export function initReveals() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
  els.forEach((el) => {
    if (el.getBoundingClientRect().top > window.innerHeight * 0.92) {
      el.style.opacity = '0'
      el.style.transform = 'translateY(18px)'
      el.style.filter = 'blur(6px)'
    }
  })
  inView(
    els,
    (el) => {
      const e = el as HTMLElement
      e.style.opacity = '1'
      e.style.transform = 'translateY(0)'
      e.style.filter = 'blur(0px)'
    },
    { margin: '0px 0px -12% 0px' }
  )
}
