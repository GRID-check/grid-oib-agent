import { landingScript } from '../i18n/ui'
import {
  computeRoi,
  isRoiDefault,
  parseRoiInputs,
  roiQuery,
  type RoiInputs,
  type RoiResult,
} from '../lib/roi'
import { formatRoi, type RoiText } from '../lib/roi-format'
import { createCounter } from './counter'

/**
 * Makes the ROI section's sliders live.
 *
 * The section already renders a correct calculation for the defaults, so this
 * only ever *re*-computes: with the script blocked the figures still hold, they
 * just stop moving. Both paths run the same model and the same formatter — the
 * numbers here cannot disagree with the ones the server wrote.
 */
/** Which dictionary the page is written in. */
const localeOf = () => (document.documentElement.lang.startsWith('en') ? 'en' : 'de') as 'en' | 'de'

/** Paint every read-out on the page from one set of figures. */
function paint(text: RoiText, skip?: keyof RoiText) {
  for (const [k, value] of Object.entries(text) as [keyof RoiText, string][]) {
    if (k === skip) continue
    document.querySelectorAll<HTMLElement>(`[data-roi-out="${k}"]`).forEach((el) => {
      if (el.textContent !== value) el.textContent = value
    })
  }
}

/**
 * The working page (/rechenweg) shows the same arithmetic for whichever office
 * the visitor set on the home page. The calculator writes its three numbers into
 * the link, so the page they land on states their figures rather than ours, and
 * its "change the numbers" link carries them back to the sliders.
 */
export function initRoiWorking() {
  const inputs = parseRoiInputs(new URLSearchParams(window.location.search))
  if (isRoiDefault(inputs)) return

  const locale = localeOf()
  paint(formatRoi(inputs, computeRoi(inputs), locale, landingScript[locale].roi))
  document.querySelectorAll<HTMLAnchorElement>('[data-roi-back]').forEach((a) => {
    a.setAttribute('href', `${a.dataset.roiBack}${roiQuery(inputs)}#wert`)
  })
}

export function initRoi() {
  const locale = localeOf()
  const units = landingScript[locale].roi
  const fields = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-roi-field]'))
  if (!fields.length) return

  // Arriving back from the working page, the sliders resume the office the
  // visitor left there rather than snapping to ours.
  const params = new URLSearchParams(window.location.search)
  if (params.has('seats') || params.has('salary') || params.has('price')) {
    const arrived = parseRoiInputs(params)
    for (const field of fields) {
      const key = field.dataset.roiField as keyof RoiInputs
      if (key in arrived) field.value = String(arrived[key])
    }
  }

  const read = (name: keyof RoiInputs) =>
    Number(fields.find((f) => f.dataset.roiField === name)?.value ?? 0)
  const readAll = (): RoiInputs => ({
    seats: read('seats'),
    salary: read('salary'),
    price: read('price'),
  })

  // The headline figure is a mechanical counter (counter.ts): its wheels turn
  // to the new value instead of the text snapping to it, because the section's
  // whole argument is that this number moves with your office. Everything else
  // on the page is set instantly — one moving figure reads as emphasis, five
  // read as a slot machine. The other copies of the figure (on the working
  // page) are plain text.
  const headline = document.querySelector<HTMLElement>('#wert [data-roi-out="net"]')
  const working = document.querySelector<HTMLAnchorElement>('[data-roi-href]')
  if (headline) headline.removeAttribute('data-roi-out')
  const counter = headline ? createCounter(headline) : null

  const apply = () => {
    // The office and the example price move; the shares the model applies are
    // assumptions the section states, not controls (see lib/roi.ts).
    const inputs = readAll()
    const result: RoiResult = computeRoi(inputs)
    const text = formatRoi(inputs, result, locale, units)
    paint(text)
    counter?.set(text.net)

    // The working page states the same figures, so the link carries them there.
    working?.setAttribute('href', `${working.dataset.roiHref}${roiQuery(inputs)}`)

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
