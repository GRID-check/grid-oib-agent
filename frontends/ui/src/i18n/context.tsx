/**
 * Client-side i18n context.
 *
 * The root layout resolves the initial locale on the server (from the user's
 * saved preference cookie or the Accept-Language header) and hands it to
 * {@link I18nProvider}. Both dictionaries are bundled, so switching language is
 * instant on the client; the choice is then mirrored to a cookie (for SSR) and
 * persisted against the user (for cross-device continuity).
 */

'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  defaultLocale,
  isLocale,
  LOCALE_COOKIE,
  localeNames,
  type Locale,
} from './config'
import { getDictionary, type Dictionary } from './dictionaries'
import { createTranslator, type Translator } from './translate'
import { fetchUserPreferences, patchUserPreferences } from '@/lib/user-preferences/client'

interface I18nContextValue {
  locale: Locale
  dictionary: Dictionary
  localeNames: Record<Locale, string>
  setLocale: (locale: Locale) => void
  /** Root translator (unscoped). Prefer {@link useTranslations} for a namespace. */
  t: Translator
}

const I18nContext = createContext<I18nContextValue | null>(null)

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

function writeLocaleCookie(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`
}

export interface I18nProviderProps {
  initialLocale: Locale
  children: ReactNode
}

export function I18nProvider({ initialLocale, children }: I18nProviderProps): ReactNode {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)
  const hydratedRef = useRef(false)

  const applyLocale = useCallback((next: Locale): void => {
    setLocaleState(next)
    writeLocaleCookie(next)
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next
    }
  }, [])

  const setLocale = useCallback(
    (next: Locale): void => {
      applyLocale(next)
      // Persist against the user for cross-device continuity. Fails soft.
      void patchUserPreferences({ locale: next })
    },
    [applyLocale],
  )

  // On first mount, reconcile with the user's saved preference. This covers a
  // fresh device where the cookie was never set and the server fell back to the
  // Accept-Language header.
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true

    let cancelled = false
    void fetchUserPreferences().then((prefs) => {
      if (cancelled) return
      if (isLocale(prefs.locale) && prefs.locale !== locale) {
        applyLocale(prefs.locale)
      }
    })
    return () => {
      cancelled = true
    }
    // Intentionally run once; `locale` is read fresh inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dictionary = useMemo(() => getDictionary(locale), [locale])
  const t = useMemo(() => createTranslator(dictionary), [dictionary])

  const value = useMemo<I18nContextValue>(
    () => ({ locale, dictionary, localeNames, setLocale, t }),
    [locale, dictionary, setLocale, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

function useI18nContext(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    // Degrade gracefully outside a provider (e.g. isolated unit tests): use the
    // default locale rather than throwing.
    const dictionary = getDictionary(defaultLocale)
    return {
      locale: defaultLocale,
      dictionary,
      localeNames,
      setLocale: () => {},
      t: createTranslator(dictionary),
    }
  }
  return ctx
}

/** Access the active locale and the setter. */
export function useLocale(): {
  locale: Locale
  setLocale: (locale: Locale) => void
  localeNames: Record<Locale, string>
} {
  const { locale, setLocale, localeNames: names } = useI18nContext()
  return { locale, setLocale, localeNames: names }
}

/**
 * Get a translator, optionally scoped to a namespace.
 *
 * @example
 * const t = useTranslations('profile')
 * t('appearance.title') // "Appearance"
 */
export function useTranslations(namespace?: string): Translator {
  const { dictionary } = useI18nContext()
  return useMemo(() => createTranslator(dictionary, namespace), [dictionary, namespace])
}

/** Full context accessor for advanced use. */
export function useI18n(): I18nContextValue {
  return useI18nContext()
}
