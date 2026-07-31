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

import { useMemo } from 'react'
import { WorkOsWidgets, UserSessions, UserSecurity } from '@workos-inc/widgets'
import '@radix-ui/themes/styles.css'

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { makeWidgetTokenFetcher } from '@/lib/workos/widget-token'
import { useResolvedAppearance, widgetTheme } from '@/lib/workos/use-widget-appearance'
import { useTranslations } from '@/i18n'

export const AccountWidgets = (): React.ReactNode => {
  const t = useTranslations('profile')
  const appearance = useResolvedAppearance()
  const fetchWidgetToken = useMemo(() => makeWidgetTokenFetcher(), [])

  return (
    <WorkOsWidgets theme={widgetTheme(appearance)}>
      {/* The provider renders a single wrapper element, so give its cards their
          own gap to match the page's card rhythm. */}
      <div className="flex flex-col gap-6">
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
      </div>
    </WorkOsWidgets>
  )
}
