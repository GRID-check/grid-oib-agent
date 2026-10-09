/**
 * The answer-feedback export as CSV: for scripts, not for people.
 *
 * RFC 4180 (comma, CRLF, every cell quoted), UTF-8 with a BOM so Excel still
 * opens the umlauts as umlauts, and every cell through `csvCell`, which also
 * neutralises a cell that would open as a formula — questions, comments and
 * answers are user and model text. The header is the columns' stable keys, the
 * columns and their order are the workbook's first sheet (`export-columns.ts`),
 * and values are written so a script needs no locale: ISO 8601 UTC for times,
 * `YYYY-MM-DD` for days, `1`/`0` for yes/no, `;` between list items, and plain
 * decimals with a dot.
 */

import type { Dictionary } from '@/i18n/dictionaries'
import { csvCell } from '@/lib/text/csv-cell'
import type { ExportCell, ExportColumn, ExportFormat } from './export-columns'

/** Decimal places per numeric format; enough for the value, never scientific notation. */
const DECIMALS: Partial<Record<ExportFormat, number>> = {
  usd: 6,
  seconds: 3,
  percent: 4,
  decimal: 4,
}

/** One value as the CSV writes it, before quoting. */
export function csvValue(value: ExportCell, format: ExportFormat): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return format === 'date' ? value.toISOString().slice(0, 10) : value.toISOString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (Array.isArray(value)) return value.join(';')
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    const places = DECIMALS[format]
    if (places === undefined) return String(Math.round(value))
    // `toFixed`, trailing zeros trimmed: 0.000012 stays a decimal where
    // `String()` would write 1.2e-5, which not every reader parses.
    return value.toFixed(places).replace(/\.?0+$/, '')
  }
  return String(value)
}

/** The whole file: BOM, header of keys, one line per row, CRLF throughout. */
export function renderCsv<Row>(
  columns: readonly ExportColumn<Row>[],
  rows: readonly Row[],
  dictionary: Dictionary
): string {
  const header = columns.map((column) => column.key).join(',')
  const lines = rows.map((row) =>
    columns.map((column) => csvCell(csvValue(column.value(row, dictionary), column.format))).join(',')
  )
  return `\uFEFF${[header, ...lines].join('\r\n')}\r\n`
}
