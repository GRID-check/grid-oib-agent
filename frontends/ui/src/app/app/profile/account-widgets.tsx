'use client'

/**
 * WorkOS account widgets (sessions + security).
 *
 * These are hosted React components from `@workos-inc/widgets` that talk
 * directly to the WorkOS API using a short-lived widget token. The token is
 * minted per request by our `/api/widgets/token` route (scoped to the signed-in
 * user + organization); we hand the widgets an async `authToken` provider so
 * they can refresh it as it nears expiry.
 *
 * The widgets render with WorkOS's Radix Themes styling, isolated under the
 * `<WorkOsWidgets>` provider. We drive their light/dark appearance from Grid's
 * own theme preference so they stay visually in sync with the rest of the app.
 */

import { useEffect, useState } from 'react'
import { WorkOsWidgets, UserSessions, UserSecurity } from '@workos-inc/widgets'
import '@radix-ui/themes/styles.css'

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { useLayoutStore } from '@/features/layout/store'
import { useTranslations } from '@/i18n'

/** Fetch a fresh widget token from our server route. Throws on failure. */
const fetchWidgetToken = async (): Promise<string> => {
  const res = await fetch('/api/widgets/token', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`Failed to load widget token (${res.status})`)
  }
  const data = (await res.json()) as { token?: string }
  if (!data.token) {
    throw new Error('Widget token missing from response')
  }
  return data.token
}

/** Resolve Grid's theme preference into a concrete light/dark appearance. */
const useResolvedAppearance = (): 'light' | 'dark' => {
  const theme = useLayoutStore((s) => s.theme)
  const [systemDark, setSystemDark] = useState(false)

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(mediaQuery.matches)
    const handler = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  if (theme === 'dark') return 'dark'
  if (theme === 'light') return 'light'
  return systemDark ? 'dark' : 'light'
}

export const AccountWidgets = (): React.ReactNode => {
  const t = useTranslations('profile')
  const appearance = useResolvedAppearance()

  return (
    <WorkOsWidgets theme={{ appearance, radius: 'medium', scaling: '100%' }}>
      <Card>
        <CardHeader>
          <CardTitle>{t('security.activeSessions')}</CardTitle>
          <CardDescription>{t('security.activeSessionsDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <UserSessions authToken={fetchWidgetToken} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('security.securityFactors')}</CardTitle>
          <CardDescription>{t('security.securityFactorsDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <UserSecurity authToken={fetchWidgetToken} />
        </CardContent>
      </Card>
    </WorkOsWidgets>
  )
}
