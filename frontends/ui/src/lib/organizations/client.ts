'use client'

/**
 * Client helper to read the organization's Grid-side default locale.
 *
 * Used to seed the interface language for a member who hasn't chosen one yet,
 * so new members start in their org's configured language. Fails soft (returns
 * null) when auth is disabled or the request fails.
 */

import { isLocale, type Locale } from '@/i18n/config'

export async function fetchOrgDefaultLocale(): Promise<Locale | null> {
  try {
    const res = await fetch('/api/organization/settings', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json()) as { settings?: { defaultLocale?: string } }
    const loc = data.settings?.defaultLocale
    return isLocale(loc) ? loc : null
  } catch {
    return null
  }
}
