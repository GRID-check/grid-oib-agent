/**
 * Format a byte count as a human-readable size (e.g. "1.5 MB").
 *
 * The number part is rendered with `Intl.NumberFormat` so the decimal
 * separator matches the active locale (German shows "1,5 MB", English
 * "1.5 MB"). Exactly one fraction digit is kept — matching the previous
 * `toFixed(1)` shape — so this change swaps only the separator, nothing else.
 * The unit suffix stays constant. `locale` is optional — omitting it uses the
 * runtime default, so callers without locale context (and tests) keep working.
 */
export function formatFileSize(bytes: number | null, locale?: string): string {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(size)
  return `${formatted} ${units[i]}`
}
