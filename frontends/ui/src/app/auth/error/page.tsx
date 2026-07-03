// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

const errorMessages: Record<string, string> = {
  Configuration: 'There is a problem with the server configuration.',
  AccessDenied: 'You do not have permission to access this resource.',
  Verification: 'The verification link has expired or has already been used.',
  Default: 'An error occurred during authentication.',
}

/**
 * Error content that uses useSearchParams (requires Suspense wrapper)
 */
const ErrorContent = (): ReactNode => {
  const router = useRouter()
  const { authRequired } = useAppConfig()
  const searchParams = useSearchParams()
  const error = searchParams?.get('error') || 'Default'
  const errorMessage = errorMessages[error] || errorMessages.Default

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
        <Spinner size="default" label="Redirecting..." />
      </div>
    )
  }

  const handleRetry = (): void => {
    window.location.href = '/'
  }

  const handleHome = (): void => {
    window.location.href = '/'
  }

  return (
    <div className="flex flex-col items-center gap-6">
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Authentication Error</AlertTitle>
        <AlertDescription>{errorMessage}</AlertDescription>
      </Alert>

      <div className="flex gap-3">
        <Button size="default" onClick={handleRetry}>
          Try Again
        </Button>
        <Button variant="secondary" size="default" onClick={handleHome}>
          Go Home
        </Button>
      </div>
    </div>
  )
}

/**
 * Auth Error Page
 */
const AuthErrorPage = (): ReactNode => {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted p-8">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-8">
                <Spinner size="default" label="Loading" />
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
