/**
 * i18n configuration.
 *
 * Grid supports English and German. Locale is a per-user preference — it is
 * persisted server-side against the WorkOS user (see /api/user/preferences)
 * and mirrored into a cookie so server components can resolve it without a DB
 * round-trip. There is deliberately no locale URL segment: this is an
 * authenticated product, not an SEO surface, so a `/en` / `/de` route prefix
 * would add churn without benefit.
 */

export const locales = ['en', 'de'] as const

export type Locale = (typeof locales)[number]

export const defaultLocale: Locale = 'en'

/** Cookie that mirrors the active locale for SSR. */
export const LOCALE_COOKIE = 'grid-locale'

/** Human-readable, self-referential language names for pickers. */
export const localeNames: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
}

/** Type guard narrowing an arbitrary string to a supported {@link Locale}. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value)
}

/**
 * Coerce an arbitrary value to a supported locale, falling back to the
 * default. Accepts full BCP-47 tags (e.g. `de-DE`) by matching the primary
 * subtag, which lets us derive a locale from an `Accept-Language` header.
 */
export function resolveLocale(value: unknown): Locale {
  if (isLocale(value)) return value
  if (typeof value === 'string') {
    const primary = value.split('-')[0]?.toLowerCase()
    if (isLocale(primary)) return primary
  }
  return defaultLocale
}
