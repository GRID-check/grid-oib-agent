// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Home Page
 *
 * Redirects authenticated users to the project workspace. While the session
 * resolves (or the redirect is in flight) it shows a quiet branded loading
 * beat instead of flashing the anonymous chat UI. Anonymous visitors get the
 * main chat layout with a sign-in affordance.
 */

'use client'

import { type ReactNode, Suspense, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/adapters/auth'
import { MainLayout } from '@/features/layout'
import { Logo } from '@/components/brand/logo'
import { Spinner } from '@/components/ui/spinner'

const BrandedLoading = (): ReactNode => (
  <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background text-foreground">
    <Logo kind="horizontal" size="large" />
    <Spinner size="sm" className="text-muted-foreground" />
    <span className="sr-only">Loading your workspace…</span>
  </div>
)

const HomeContent = (): ReactNode => {
  const { isAuthenticated, signIn, isLoading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      router.replace('/projects')
    }
  }, [isAuthenticated, isLoading, router])

  // Session resolving, or authenticated and redirecting → branded loading beat.
  if (isLoading || isAuthenticated) {
    return <BrandedLoading />
  }

  return (
    <MainLayout
      isAuthenticated={isAuthenticated}
      onSignIn={signIn}
    />
  )
}

const HomePage = (): ReactNode => {
  return (
    <Suspense fallback={<BrandedLoading />}>
      <HomeContent />
    </Suspense>
  )
}

export default HomePage
