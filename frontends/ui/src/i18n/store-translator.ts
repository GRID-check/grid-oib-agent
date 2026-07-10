/**
 * Store-side translator.
 *
 * Zustand stores and other non-React modules cannot call the `useTranslations`
 * hook, but they still surface user-facing copy (e.g. toast notifications when
 * a background job fails to cancel). This helper resolves the active locale
 * from the same cookie the {@link I18nProvider} mirrors it into, then builds a
 * one-off translator over the bundled dictionaries.
 *
 * It is intentionally NOT reactive: it reads the locale at call time, which is
 * exactly right for imperative, fire-and-forget messages. React components must
 * keep using `useTranslations` so they re-render on a language switch.
 */

import { getDictionary } from './dictionaries'
import { createTranslator, type Translator } from './translate'
import { LOCALE_COOKIE, defaultLocale, resolveLocale, type Locale } from './config'

/** Read the active locale from the mirror cookie (falls back to default). */
function readActiveLocale(): Locale {
  if (typeof document === 'undefined') return defaultLocale
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`),
  )
  return resolveLocale(match ? decodeURIComponent(match[1]) : undefined)
}

/**
 * Build a translator bound to the active locale, optionally scoped to a
 * namespace. Call this at the point of use (not module load) so it always
 * reflects the current language.
 */
export function getStoreTranslator(namespace?: string): Translator {
  return createTranslator(getDictionary(readActiveLocale()), namespace)
}
