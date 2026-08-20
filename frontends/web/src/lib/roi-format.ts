/**
 * The one place ROI numbers become text.
 *
 * The section renders the default calculation on the server and the browser
 * recomputes it on every slider move; both call this, so a figure never changes
 * shape between the two — no "45600" flashing over "45.600 €" on hydration.
 */

import type { Locale } from '../i18n/ui'
import type { RoiInputs, RoiResult } from './roi'

/** Unit wrappers the dictionary owns, because they are language, not maths. */
export interface RoiUnits {
  /** `'{value} h'` */
  hours: string
  /** `'≈ {value} Vollzeitstellen'` */
  fte: string
  /** `'{value} Monate'` */
  months: string
  /** `'{value}×'` */
  ratio: string
  /** Shown where a figure has no meaningful value. */
  never: string
}

/** The readouts the section paints, keyed by their `data-roi-out` value. */
export interface RoiText {
  seats: string
  salary: string
  net: string
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

/** A share written as a percentage — used for the claims the section states. */
export const formatShare = (locale: Locale, value: number) =>
  format(locale, { style: 'percent', maximumFractionDigits: 0 }, value)

const decimal = (locale: Locale, value: number, digits = 0) =>
  format(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }, value)

export const fillTemplate = (template: string, value: string) => template.replace('{value}', value)

export function formatRoi(
  inputs: RoiInputs,
  result: RoiResult,
  locale: Locale,
  units: RoiUnits
): RoiText {
  return {
    seats: decimal(locale, inputs.seats),
    salary: formatEuro(locale, inputs.salary),
    net: formatEuro(locale, result.netValue),
    hours: fillTemplate(units.hours, decimal(locale, Math.round(result.hoursPerYear))),
    fte: fillTemplate(units.fte, decimal(locale, result.fte, 1)),
    payback: Number.isFinite(result.paybackMonths)
      ? fillTemplate(units.months, decimal(locale, result.paybackMonths, 1))
      : units.never,
    ratio: fillTemplate(units.ratio, decimal(locale, result.returnFactor, 1)),
  }
}
