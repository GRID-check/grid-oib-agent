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
