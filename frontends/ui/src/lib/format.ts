/** Shared display formatters. */

/**
 * EUR currency — the app's single money-display rule. Pass the active locale
 * so German users see "12,34 €" and English users "€12.34". Locale is
 * optional so non-React callers without locale context keep working (they
 * get the runtime default).
 */
export const formatEur = (value: number, locale?: string): string =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value)
