import { DURATION, cssEase, reducedMotion } from '../lib/motion'

/**
 * A figure set as a mechanical counter: when the value changes, only the
 * digits that changed turn, each on its own wheel, one step up or down. It
 * says which part of the result a slider moved, and it never shows a figure
 * that is not a result (the text count-up it replaces raced through every
 * value in between and was caught showing 41.996 € on its way to 42.000 €).
 *
 * Nothing moves until the reader moves a slider: the figure arrives with its
 * section like any other text.
 *
 * The element keeps its formatted text for assistive technology (a visually
 * hidden copy); the wheels are `aria-hidden`. Digits must be tabular so every
 * wheel is one width. Transform only. Under reduced motion the text is set.
 */
export interface Counter {
  set(text: string): void
}

const isDigit = (c: string) => c >= '0' && c <= '9'

export function createCounter(el: HTMLElement): Counter {
  let shown = el.textContent?.trim() ?? ''
  if (reducedMotion() || !el.animate) {
    return {
      set(text) {
        if (el.textContent !== text) el.textContent = text
        shown = text
      },
    }
  }

  const said = document.createElement('span')
  said.className = 'sr-only'
  const face = document.createElement('span')
  face.setAttribute('aria-hidden', 'true')
  face.className = 'counter'
  let wheels: (HTMLElement | null)[] = []

  const row = (d: number) => `translateY(${-d * 10}%)`

  /** One face for `text`: a wheel per digit, plain text otherwise. */
  const build = (text: string) => {
    face.textContent = ''
    wheels = [...text].map((c) => {
      if (!isDigit(c)) {
        face.append(c)
        return null
      }
      const win = document.createElement('span')
      win.className = 'counter__window'
      const wheel = document.createElement('span')
      wheel.className = 'counter__wheel'
      for (let d = 0; d < 10; d++) {
        const digit = document.createElement('span')
        digit.textContent = String(d)
        wheel.appendChild(digit)
      }
      wheel.style.transform = row(Number(c))
      win.appendChild(wheel)
      face.appendChild(win)
      return wheel
    })
  }

  el.textContent = ''
  el.append(said, face)
  said.textContent = shown
  build(shown)

  return {
    set(text) {
      if (text === shown) return
      said.textContent = text
      // A figure that gains or loses a digit is a different layout of wheels;
      // it is set, not turned.
      const sameShape =
        text.length === shown.length && [...text].every((c, i) => isDigit(c) === isDigit(shown[i]))
      if (!sameShape) {
        build(text)
        shown = text
        return
      }
      ;[...text].forEach((c, i) => {
        const wheel = wheels[i]
        if (!wheel || c === shown[i]) return
        wheel.getAnimations().forEach((a) => a.cancel())
        wheel.animate([{ transform: row(Number(shown[i])) }, { transform: row(Number(c)) }], {
          duration: DURATION.quick,
          easing: cssEase('settle'),
        })
        wheel.style.transform = row(Number(c))
      })
      shown = text
    },
  }
}
