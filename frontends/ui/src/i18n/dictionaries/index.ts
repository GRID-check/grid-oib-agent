/**
 * Dictionary registry.
 *
 * Both locales are bundled to the client (each is a few KB of plain strings),
 * which lets the language switcher swap copy instantly without a network
 * round-trip. `Dictionary` is derived from the English source so it is the
 * single source of truth for the message shape.
 */

import { en } from './en'
import { de } from './de'
import type { Locale } from '../config'

/** The canonical message shape, derived from English. */
export type Dictionary = typeof en

export const dictionaries: Record<Locale, Dictionary> = { en, de }

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? en
}

export { en, de }
