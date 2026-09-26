import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { landingScript } from '../i18n/ui'
import {
  computeRoi,
  isRoiDefault,
  parseRoiInputs,
  roiQuery,
  type RoiInputs,
  type RoiResult,
} from '../lib/roi'
import { fillTemplate, formatHeadline, formatRoi, type RoiText } from '../lib/roi-format'

gsap.registerPlugin(ScrollTrigger)

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

  // The headline figure counts to its value instead of snapping to it: the
  // section's whole argument is that this number moves with your office, and a
  // number that visibly travels says so before the copy does. Everything else
  // on the page is set instantly — one animated figure reads as emphasis, five
  // read as a slot machine.
  const headline = document.querySelector<HTMLElement>('#wert [data-roi-out="headline"]')
  const working = document.querySelector<HTMLAnchorElement>('[data-roi-href]')
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let shown = computeRoi(readAll()).netValue
  let count: gsap.core.Tween | null = null

  // In flight the figure is rounded exactly as the result is, so a frame caught
  // mid-count still reads as an estimate ("≈ 41.900 €"), never as "41.996 €".
  const countTo = (value: number, duration: number) => {
    if (!headline || reduced || value === shown) return false
    count?.kill()
    const counter = { v: shown }
    count = gsap.to(counter, {
      v: value,
      duration,
      ease: 'power2.out',
      onUpdate: () => {
        headline.textContent = formatHeadline(locale, units, counter.v)
      },
      onComplete: () => {
        headline.textContent = formatHeadline(locale, units, value)
      },
    })
    shown = value
    return true
  }

  const apply = () => {
    // The office and the example price move; the shares the model applies are
    // assumptions the section states, not controls (see lib/roi.ts).
    const inputs = readAll()
    const result: RoiResult = computeRoi(inputs)
    const text = formatRoi(inputs, result, locale, units)
    // The headline is mid-flight while it counts; writing the final string over
    // it would cancel the count visually on the very first frame.
    paint(text, countTo(result.netValue, 0.32) ? 'headline' : undefined)

    // The working page states the same figures, so the link carries them there.
    working?.setAttribute('href', `${working.dataset.roiHref}${roiQuery(inputs)}`)

    for (const field of fields) {
      const key = field.dataset.roiField as keyof RoiText
      // The visible readout and what a screen reader hears are the same string:
      // "30 %", not the bare "30" a range would otherwise announce.
      const spoken = key === 'seats' ? fillTemplate(units.seatsSpoken, text.seats) : text[key]
      if (spoken) field.setAttribute('aria-valuetext', spoken)
      const min = Number(field.min)
      const span = Number(field.max) - min || 1
      field.style.setProperty('--fill', `${((Number(field.value) - min) / span) * 100}%`)
    }
  }

  // The seat stepper nudges the slider and lets it report the change, so the
  // two controls cannot disagree about the office.
  const seats = fields.find((f) => f.dataset.roiField === 'seats')
  const steppers = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-roi-step]'))
  const syncSteppers = () => {
    if (!seats) return
    for (const b of steppers) {
      const up = Number(b.dataset.roiStep) > 0
      b.disabled = up ? Number(seats.value) >= Number(seats.max) : Number(seats.value) <= Number(seats.min)
    }
  }
  for (const b of steppers) {
    b.addEventListener('click', () => {
      if (!seats) return
      if (Number(b.dataset.roiStep) > 0) seats.stepUp()
      else seats.stepDown()
      seats.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  fields.forEach((field) => field.addEventListener('input', () => (apply(), syncSteppers())))
  apply()
  syncSteppers()

  // On first sight the figure counts up to its value, from 60 % of it rather
  // than from nothing: a count from zero spends most of its time on figures
  // nobody should read. It only runs when the section is still below the fold.
  // The start value is written before the visitor can see the headline, so the
  // server's final figure never flashes and then drops. A visitor without
  // motion or without JS reads the server's figure, and so does one who loads
  // the page already scrolled to it.
  if (headline && !reduced && headline.getBoundingClientRect().top > window.innerHeight) {
    shown *= 0.6
    headline.textContent = formatHeadline(locale, units, shown)
    ScrollTrigger.create({
      trigger: headline,
      start: 'top 90%',
      once: true,
      // Read again on entry: a slider moved before this point already set it.
      onEnter: () => countTo(computeRoi(readAll()).netValue, 0.7),
    })
  }
}
