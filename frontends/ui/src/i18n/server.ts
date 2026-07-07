/**
 * Server-side i18n helpers for use in Server Components, layouts, and route
 * handlers. These resolve the request locale from the cookie the client keeps
 * in sync, falling back to the `Accept-Language` header and finally the
 * default locale.
 */

import 'server-only'
import { cookies, headers } from 'next/headers'
import { LOCALE_COOKIE, defaultLocale, isLocale, resolveLocale, type Locale } from './config'
import { getDictionary } from './dictionaries'
import { createTranslator, type Translator } from './translate'

/** Parse the primary language out of an `Accept-Language` header. */
function localeFromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim()
    if (!tag) continue
    const candidate = resolveLocale(tag)
    // resolveLocale never returns null; only accept a real header match.
    if (isLocale(tag) || isLocale(tag.split('-')[0])) return candidate
  }
  return null
}

/** Resolve the active locale for the current request. */
export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies()
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value
  if (isLocale(cookieLocale)) return cookieLocale

  const headerStore = await headers()
  const fromHeader = localeFromAcceptLanguage(headerStore.get('accept-language'))
  if (fromHeader) return fromHeader

  return defaultLocale
}

/**
 * Get a server-side translator, optionally scoped to a namespace.
 *
 * @example
 * const t = await getTranslations('errors')
 * t('notFound.title')
 */
export async function getTranslations(namespace?: string): Promise<Translator> {
  const locale = await getLocale()
  return createTranslator(getDictionary(locale), namespace)
}
