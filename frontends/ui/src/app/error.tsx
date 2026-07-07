'use client'

import { useEffect } from 'react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { StatusScreen } from '@/components/brand/status-screen'
import { useTranslations } from '@/i18n'

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

  const isAccess = /not found|forbidden|unauthorized|access/i.test(error.message)

  return (
    <StatusScreen
      code={isAccess ? t('access.code') : t('appError.code')}
      title={isAccess ? t('access.title') : t('appError.title')}
      description={isAccess ? t('access.description') : t('appError.description')}
      actions={
        <>
          {!isAccess && (
            <Button variant="outline" onClick={reset}>
              {t('appError.action')}
            </Button>
          )}
          <Button asChild>
            <Link href="/app/projects">{t('appError.backAction')}</Link>
          </Button>
        </>
      }
    />
  )
}
