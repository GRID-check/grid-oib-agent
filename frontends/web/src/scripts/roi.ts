import { animate, inView, type AnimationPlaybackControls } from 'motion'
import { landingScript } from '../i18n/ui'
import { computeRoi, type RoiInputs, type RoiResult } from '../lib/roi'
import { formatEuro, formatRoi, type RoiText } from '../lib/roi-format'

/**
 * Makes the ROI section's sliders live.
 *
 * The section already renders a correct calculation for the defaults, so this
 * only ever *re*-computes: with the script blocked the figures still hold, they
 * just stop moving. Both paths run the same model and the same formatter — the
 * numbers here cannot disagree with the ones the server wrote.
 */
export function initRoi() {
  const locale = document.documentElement.lang.startsWith('en') ? 'en' : 'de'
  const units = landingScript[locale].roi
  const fields = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-roi-field]'))
  if (!fields.length) return

  const read = (name: string) =>
    Number(fields.find((f) => f.dataset.roiField === name)?.value ?? 0)

  // The headline figure counts to its value instead of snapping to it: the
  // section's whole argument is that this number moves with your office, and a
  // number that visibly travels says so before the copy does. Everything else
  // on the page is set instantly — one animated figure reads as emphasis, five
  // read as a slot machine.
  const headline = document.querySelector<HTMLElement>('#wert [data-roi-out="net"]')
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let shown = computeRoi({ seats: read('seats'), salary: read('salary') }).netValue
  let count: AnimationPlaybackControls | null = null

  const countTo = (value: number, duration: number) => {
    if (!headline || reduced || value === shown) return false
    count?.stop()
    count = animate(shown, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        headline.textContent = formatEuro(locale, v)
      },
      onComplete: () => {
        headline.textContent = formatEuro(locale, value)
      },
    })
    shown = value
    return true
  }

  const apply = () => {
    // Only the office's own two numbers move; the shares the model applies are
    // claims the section states, not controls (see lib/roi.ts).
    const inputs: RoiInputs = { seats: read('seats'), salary: read('salary') }
    const result: RoiResult = computeRoi(inputs)
    const text = formatRoi(inputs, result, locale, units)
    const animated = countTo(result.netValue, 0.32)

    for (const [key, value] of Object.entries(text) as [keyof RoiText, string][]) {
      // The headline is mid-flight; writing the final string over it would
      // cancel the count visually on the very first frame.
      if (animated && key === 'net') {
        document
          .querySelectorAll<HTMLElement>('[data-roi-out="net"]:not(#wert [data-roi-out="net"])')
          .forEach((el) => {
            if (el.textContent !== value) el.textContent = value
          })
        continue
      }
      // Both the calculator and the derivation two sections down paint from
      // this one loop, which is why they can never show different arithmetic.
      document.querySelectorAll<HTMLElement>(`[data-roi-out="${key}"]`).forEach((el) => {
        if (el.textContent !== value) el.textContent = value
      })
    }

    for (const field of fields) {
      const key = field.dataset.roiField as keyof RoiText
      // The visible readout and what a screen reader hears are the same string:
      // "30 %", not the bare "30" a range would otherwise announce.
      if (text[key]) field.setAttribute('aria-valuetext', text[key])
      const min = Number(field.min)
      const span = Number(field.max) - min || 1
      field.style.setProperty('--fill', `${((Number(field.value) - min) / span) * 100}%`)
    }
  }

  fields.forEach((field) => field.addEventListener('input', apply))
  apply()

  // On first sight the figure counts up from nothing — the server already wrote
  // the final value, so a visitor without motion, or without JS, simply reads it.
  if (headline && !reduced) {
    inView(
      headline,
      () => {
        const target = shown
        shown = 0
        countTo(target, 1.1)
      },
      { amount: 0.9 }
    )
  }
}
