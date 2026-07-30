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
import { defaultLocale, isLocale, LOCALE_COOKIE, localeNames, type Locale } from './config'
import { getDictionary, type Dictionary } from './dictionaries'
import { createTranslator, type Translator } from './translate'
import { fetchUserPreferences, patchUserPreferences } from '@/lib/user-preferences/client'
import { fetchOrgDefaultLocale } from '@/lib/organizations/client'

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
  /**
   * Pin the locale to {@link initialLocale}: skip the first-mount reconciliation
   * against the user's saved preference and their organization's default.
   *
   * For the `/dev/*` preview routes only. Those pages exist to produce screenshot
   * evidence, so the copy they render must be the same on every machine rather
   * than whatever language the developer's own account happens to prefer.
   */
  fixedLocale?: boolean
  children: ReactNode
}

export function I18nProvider({
  initialLocale,
  fixedLocale = false,
  children,
}: I18nProviderProps): ReactNode {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)
  const hydratedRef = useRef(false)
  /** The CURRENT locale, readable from the run-once effect's stale closure. */
  const localeRef = useRef(initialLocale)
  localeRef.current = locale

  const applyLocale = useCallback((next: Locale): void => {
    setLocaleState(next)
    writeLocaleCookie(next)
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next
    }
  }, [])

  /**
   * Set once the user picks a language themselves, and never unset.
   *
   * Reconciliation below is a *guess* at what they would have wanted; an explicit
   * choice is the answer. Once the answer exists the guess must be abandoned, even
   * mid-flight — see the effect.
   */
  const chosenRef = useRef(false)

  const setLocale = useCallback(
    (next: Locale): void => {
      chosenRef.current = true
      applyLocale(next)
      // Persist against the user for cross-device continuity. Fails soft.
      void patchUserPreferences({ locale: next })
    },
    [applyLocale]
  )

  // On first mount, reconcile the active locale with the user's context:
  //   1. their saved personal preference (cross-device), else
  //   2. their organization's default language (so a new member starts in the
  //      org's configured language until they pick their own).
  // This covers a fresh device where the cookie was never set and the server
  // fell back to the Accept-Language header.
  //
  // `fixedLocale` opts out: a preview route asked for one specific language and
  // must keep it, whoever is looking at it.
  useEffect(() => {
    if (fixedLocale || hydratedRef.current) return
    hydratedRef.current = true

    let cancelled = false
    void (async () => {
      const prefs = await fetchUserPreferences()
      // `chosenRef` is checked after EVERY await, not just at the start. Both
      // lookups are in flight for real time, and the user can pick a language
      // while they are — at which point this reconciliation is answering a
      // question that has since been answered properly. Applying it anyway flips
      // the UI and rewrites the cookie moments after an explicit choice, using a
      // value that was already stale when it was read (the `setLocale` PATCH does
      // not necessarily land before this GET returns).
      if (cancelled || chosenRef.current) return

      if (isLocale(prefs.locale)) {
        if (prefs.locale !== localeRef.current) applyLocale(prefs.locale)
        return
      }

      // No personal locale yet — inherit the org default. applyLocale writes the
      // cookie, so subsequent loads render server-side in this language with no
      // flash. We intentionally do NOT persist it as a chosen preference, so an
      // admin changing the org default still reaches members who never picked.
      const orgLocale = await fetchOrgDefaultLocale()
      if (cancelled || chosenRef.current || !isLocale(orgLocale)) return
      if (orgLocale !== localeRef.current) applyLocale(orgLocale)
    })()

    return () => {
      cancelled = true
    }
    // Runs once. The comparisons above go through `localeRef`, NOT the `locale`
    // closed over here: with an empty dependency list that binding is the
    // MOUNT-time value, so comparing against it asks "did this differ when the
    // page opened?" when the question is "does it differ now?".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dictionary = useMemo(() => getDictionary(locale), [locale])
  const t = useMemo(() => createTranslator(dictionary), [dictionary])

  const value = useMemo<I18nContextValue>(
    () => ({ locale, dictionary, localeNames, setLocale, t }),
    [locale, dictionary, setLocale, t]
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
