/**
 * The one place ROI numbers become text.
 *
 * The section renders the default calculation on the server and the browser
 * recomputes it on every slider move; both call this, so a figure never changes
 * shape between the two — no "45600" flashing over "45.600 €" on hydration.
 */

import type { Locale } from '../i18n/ui'
import { WEEK_HOURS, type RoiInputs, type RoiResult } from './roi'

/** Unit wrappers the dictionary owns, because they are language, not maths. */
export interface RoiUnits {
  /** `'{value} h/Jahr'` */
  hours: string
  /** `'{value} h'` — a bare hour figure, used in the derivation. */
  hoursPlain: string
  /** `'{value}/h'` — an hourly rate. */
  perHour: string
  /** `'× {value}'` — a multiplier row in the derivation. */
  times: string
  /** `'12 × {value}'` — the example price over a year. */
  perYear: string
  /** `'−{value}'` — a deduction, with a typographic minus. */
  minus: string
  /** `'≈ {value} Vollzeitstellen'` */
  fte: string
  /** `'{value} Monate'` */
  months: string
  /** `'{value}×'` */
  ratio: string
  /** Shown where a figure has no meaningful value. */
  never: string
  /** `'≈ {value}'` — a figure rounded because its inputs are assumptions. */
  approx: string
  /** `'{value} Planer:innen'` — the seat count as a screen reader should hear it. */
  seatsSpoken: string
  /** `'… für {seats} Plätze … {salary} … {price}'` — which office a working belongs to. */
  office: string
  /** The same sentence for a single seat, where the plural would read wrong. */
  officeOne: string
}

/** The readouts the section paints, keyed by their `data-roi-out` value. */
export interface RoiText {
  seats: string
  salary: string
  price: string
  /** Derivation rows, in the order the section states them. */
  weekHours: string
  planHours: string
  researchHours: string
  restHours: string
  backHours: string
  yearHours: string
  hourly: string
  perSeat: string
  licencePerSeat: string
  /** `12 × 150 €` — how the licence row is made up. */
  licenceWorking: string
  netPerSeat: string
  seatsTimes: string
  office: string
  /** The exact net value, as the working page derives it. */
  net: string
  /**
   * The same value as the calculator's headline states it: rounded to hundreds
   * and marked "≈", because every input behind it is an assumption or an
   * example. "41.996 €" would claim a precision the model does not have.
   */
  headline: string
  hours: string
  fte: string
  payback: string
  ratio: string
}

/**
 * de-DE and en-IE, not de-AT and en-GB: they are the two that write a euro the
 * way this site already writes one in its copy — "4.200 €" and "€4,200". CLDR's
 * de-AT would set "€ 10 164" against the "4.200 €" three sections above it.
 */
const NUMBER_LOCALES: Record<Locale, string> = { de: 'de-DE', en: 'en-IE' }

const format = (locale: Locale, options: Intl.NumberFormatOptions, value: number) =>
  new Intl.NumberFormat(NUMBER_LOCALES[locale], options).format(value)

/** Whole euros, written the way the visitor's locale writes them. */
export const formatEuro = (locale: Locale, value: number) =>
  format(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }, value)

/** Euros to the cent — the hourly rate is the one figure where cents matter. */
const formatEuro2 = (locale: Locale, value: number) =>
  format(locale, { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }, value)

/** A share written as a percentage — used for the claims the section states. */
export const formatShare = (locale: Locale, value: number) =>
  format(locale, { style: 'percent', maximumFractionDigits: 0 }, value)

const decimal = (locale: Locale, value: number, digits = 0) =>
  format(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }, value)

export const fillTemplate = (template: string, value: string) => template.replace('{value}', value)

/** The step the headline figure is rounded to, in euros. */
export const HEADLINE_STEP = 100

/** The calculator's headline: rounded to `HEADLINE_STEP` and marked as approximate. */
export const formatHeadline = (locale: Locale, units: RoiUnits, value: number) =>
  fillTemplate(units.approx, formatEuro(locale, Math.round(value / HEADLINE_STEP) * HEADLINE_STEP))

export function formatRoi(
  inputs: RoiInputs,
  result: RoiResult,
  locale: Locale,
  units: RoiUnits
): RoiText {
  const hours = (value: number, digits = 0) =>
    fillTemplate(units.hoursPlain, decimal(locale, value, digits))

  return {
    seats: decimal(locale, inputs.seats),
    salary: formatEuro(locale, inputs.salary),
    price: formatEuro(locale, inputs.price),
    weekHours: hours(WEEK_HOURS),
    planHours: hours(WEEK_HOURS - result.researchHoursPerWeek),
    researchHours: hours(result.researchHoursPerWeek),
    restHours: hours(result.researchHoursPerWeek - result.hoursPerWeek, 1),
    // One decimal, because 4.8 rounded to 5 would overstate the claim by 4 %.
    backHours: hours(result.hoursPerWeek, 1),
    yearHours: hours(Math.round(result.hoursPerYearPerSeat)),
    hourly: fillTemplate(units.perHour, formatEuro2(locale, result.hourlyCost)),
    perSeat: formatEuro(locale, result.valuePerSeat),
    licencePerSeat: fillTemplate(units.minus, formatEuro(locale, result.licencePerSeat)),
    licenceWorking: fillTemplate(units.perYear, formatEuro(locale, inputs.price)),
    netPerSeat: formatEuro(locale, result.netPerSeat),
    seatsTimes: fillTemplate(units.times, decimal(locale, inputs.seats)),
    office: (inputs.seats === 1 ? units.officeOne : units.office)
      .replace('{seats}', decimal(locale, inputs.seats))
      .replace('{salary}', formatEuro(locale, inputs.salary))
      .replace('{price}', formatEuro(locale, inputs.price)),
    net: formatEuro(locale, result.netValue),
    headline: formatHeadline(locale, units, result.netValue),
    hours: fillTemplate(units.hours, decimal(locale, Math.round(result.hoursPerYear))),
    fte: fillTemplate(units.fte, decimal(locale, result.fte, 1)),
    payback: Number.isFinite(result.paybackMonths)
      ? fillTemplate(units.months, decimal(locale, result.paybackMonths, 1))
      : units.never,
    ratio: fillTemplate(units.ratio, decimal(locale, result.returnFactor, 1)),
  }
}
