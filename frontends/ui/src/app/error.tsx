'use client'

import { useEffect } from 'react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { StatusScreen } from '@/components/brand/status-screen'
import { useTranslations } from '@/i18n'
import { isAuthzError } from '@/lib/auth-utils'

/**
 * Route-level error boundary. Catches thrown errors (including the plain
 * Error('Not found') that requireProjectAccess raises on permission denial)
 * and renders GRID's own chrome instead of Next's default crash page.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations('errors')

  useEffect(() => {
    console.error('[route error]', error)
  }, [error])

  // Classify on the same typed authz signal the API route handlers and page
  // guards use (`isAuthzError`, `@/lib/auth-utils`) — never a bare substring
  // match. A naive /access/i regex also matches unrelated crashes such as
  // "Cannot access 'x' before initialization", which would misroute a real
  // bug to the access-denied screen. `isAuthzError` only matches the app's
  // actual authz message convention ("not found", "forbidden",
  // "unauthorized" — see `requireProjectAccess`'s `NotFoundError` and
  // `NoOrganizationError`), so an unknown error always falls through to the
  // generic screen (fail-safe).
  const isAccess = isAuthzError(error)

  return (
    <StatusScreen
      code={isAccess ? t('access.code') : t('appError.code')}
      title={isAccess ? t('access.title') : t('appError.title')}
      description={isAccess ? t('access.description') : t('appError.description')}
      actions={
        <>
          {/* Always offered, even on the access screen: an unknown error must
              never be hidden behind a dead-end, and even a genuine access
              denial can be transient (a role grant that just landed, a stale
              cache). */}
          <Button variant="outline" onClick={reset}>
            {t('appError.action')}
          </Button>
          {isAccess ? (
            // Home re-resolves the session client-side and never rethrows:
            // an authenticated visitor bounces straight to /app/projects, a
            // signed-out one lands on the sign-in screen. Routing back to
            // the project/org page that just failed here would re-run the
            // same guard and re-throw the same error — a dead-end loop.
            <Button asChild>
              <Link href="/">{t('access.action')}</Link>
            </Button>
          ) : (
            <Button asChild>
              <Link href="/app/projects">{t('appError.backAction')}</Link>
            </Button>
          )}
        </>
      }
    />
  )
}
