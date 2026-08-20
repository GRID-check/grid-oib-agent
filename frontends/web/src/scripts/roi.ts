import { landingScript } from '../i18n/ui'
import { computeRoi, type RoiInputs } from '../lib/roi'
import { formatRoi, type RoiText } from '../lib/roi-format'

/**
 * Makes the ROI section's sliders live.
 *
 * The section already renders a correct calculation for the defaults, so this
 * only ever *re*-computes: with the script blocked the figures still hold, they
 * just stop moving. Both paths run the same model and the same formatter — the
 * numbers here cannot disagree with the ones the server wrote.
 */
export function initRoi() {
  const root = document.querySelector<HTMLElement>('[data-roi]')
  if (!root) return

  const locale = document.documentElement.lang.startsWith('en') ? 'en' : 'de'
  const units = landingScript[locale].roi
  const fields = Array.from(root.querySelectorAll<HTMLInputElement>('input[data-roi-field]'))
  if (!fields.length) return

  const read = (name: string) =>
    Number(fields.find((f) => f.dataset.roiField === name)?.value ?? 0)

  const apply = () => {
    // Only the office's own two numbers move; the shares the model applies are
    // claims the section states, not controls (see lib/roi.ts).
    const inputs: RoiInputs = { seats: read('seats'), salary: read('salary') }
    const text = formatRoi(inputs, computeRoi(inputs), locale, units)

    for (const [key, value] of Object.entries(text) as [keyof RoiText, string][]) {
      root
        .querySelectorAll<HTMLElement>(`[data-roi-out="${key}"]`)
        .forEach((el) => {
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
}
