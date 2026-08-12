/**
 * How one published property value is written on screen.
 *
 * Shared, because it was not: the model page ran a number through
 * `toLocaleString` and the chat card ran the same number through `String`, so
 * a wall thickness read `0,38` on one surface and `0.38` on the other. Two
 * renderings of one value is the small end of the same problem the rest of
 * this subsystem is about — the reader cannot tell which one the model
 * actually says.
 *
 * An IFC boolean is a fact about the building, not a programming value, so it
 * reads as a word. `Ja`/`Nein` in both locales on purpose: the surrounding
 * property NAMES are the exporter's (`IsExternal`, `LoadBearing`) and are
 * never translated, so an English "Yes" beside a German model's own vocabulary
 * would be a third language in one row.
 */
export function formatPropertyValue(
  value: string | number | boolean | null,
  locale: string
): string {
  if (value === null) return '—'
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein'
  if (typeof value === 'number') return (Math.round(value * 1000) / 1000).toLocaleString(locale)
  return value
}

/**
 * A published TOTAL with the unit the file declares — floor area, volume.
 *
 * Numbers follow the INTERFACE locale, not a hard-coded Austrian one. A German
 * UI writes 74,2 m² and an English one 74.2 m²; pinning `de-AT` would have put
 * a German decimal comma in an English sentence, where it reads as a thousands
 * separator and changes the number by a factor of ten.
 *
 * `null` is an absent quantity, NOT a zero: an export that publishes no
 * `Qto_*` set says nothing about the building's area, and printing 0 would say
 * something false. It renders as an em dash, and callers that can omit the row
 * entirely should.
 *
 * Unlike a per-element quantity, a unit may be printed here: these totals are
 * summed server-side in the file's own declared unit system, which
 * `summary.units` names — the element rows have no such guarantee and
 * deliberately print no unit at all.
 */
export function formatMeasure(value: number | null, unit: string, locale: string): string {
  if (value === null) return '—'
  const rounded = Math.round(value * 100) / 100
  return `${rounded.toLocaleString(locale)} ${unit}`
}

/**
 * A length in metres, always to two decimals, in the interface locale.
 *
 * The trailing zero is kept on purpose: `2,40 m` is a dimension and `2,4 m` is
 * a rounded-off estimate, and every drawing convention distinguishes them.
 *
 * The LOCALE is the point of this living here rather than in three files.
 * `toFixed` writes a decimal POINT, and the measurement readout, the storey
 * elevations in the Struktur tree, the Geschoße rail and the section-height
 * caption all used it — so a German interface printed `2.40 m` for the one
 * number an architect checks a Durchgangsbreite with, in the one notation
 * where a point is a thousands separator. This file's header records the same
 * bug for property values.
 */
export function formatMetresIn(metres: number, locale: string): string {
  return metres.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
