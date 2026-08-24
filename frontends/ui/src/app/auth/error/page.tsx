/**
 * Auth Error Page
 *
 * Displayed when authentication fails.
 * Redirects to home when REQUIRE_AUTH=false since auth is not needed.
 */

'use client'

import { type ReactNode, Suspense, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAppConfig } from '@/shared/context'
import { useAuth } from '@/adapters/auth'
import { useTranslations } from '@/i18n'

/**
 * Error content that uses useSearchParams (requires Suspense wrapper)
 */
const ErrorContent = (): ReactNode => {
  const router = useRouter()
  const { authRequired } = useAppConfig()
  const { signIn } = useAuth()
  const searchParams = useSearchParams()
  const t = useTranslations('errors')
  const error = searchParams?.get('error') || 'Default'
  const knownKeys = ['Configuration', 'AccessDenied', 'Verification', 'Default']
  const messageKey = knownKeys.includes(error) ? error : 'Default'
  const errorMessage = t(`auth.messages.${messageKey}`)

  // Redirect to home if auth is disabled - this page is not needed
  useEffect(() => {
    if (!authRequired) {
      router.replace('/')
    }
  }, [authRequired, router])

  // Show loading while redirecting
  if (!authRequired) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner size="default" label={t('auth.redirecting')} />
      </div>
    )
  }

  // "Try again" re-initiates the AuthKit sign-in flow (the same mechanism the
  // landing page uses) rather than merely bouncing home like "Go home".
  const handleRetry = (): void => {
    void signIn()
  }

  const handleHome = (): void => {
    window.location.href = '/'
  }

  return (
    <div className="flex flex-col items-center gap-6">
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>{t('auth.heading')}</AlertTitle>
        <AlertDescription>{errorMessage}</AlertDescription>
      </Alert>

      <div className="flex gap-3">
        <Button size="default" onClick={handleRetry}>
          {t('auth.tryAgain')}
        </Button>
        <Button variant="secondary" size="default" onClick={handleHome}>
          {t('auth.goHome')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Auth Error Page
 */
const AuthErrorPage = (): ReactNode => {
  const t = useTranslations('errors')
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted p-4 sm:p-8">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-8">
                <Spinner size="default" label={t('auth.loading')} />
              </div>
            }
          >
            <ErrorContent />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  )
}

export default AuthErrorPage
