/**
 * Public i18n entry point for client code.
 *
 * Client components import hooks and the provider from here. Server Components
 * and route handlers should import from `@/i18n/server` instead (that module is
 * `server-only` and would fail if pulled into a client bundle).
 */

export {
  locales,
  defaultLocale,
  localeNames,
  isLocale,
  resolveLocale,
  LOCALE_COOKIE,
  type Locale,
} from './config'

export {
  I18nProvider,
  useI18n,
  useLocale,
  useTranslations,
  type I18nProviderProps,
} from './context'

export type { Translator, TranslationVars } from './translate'
export { getDictionary, type Dictionary } from './dictionaries'
export { getStoreTranslator } from './store-translator'
