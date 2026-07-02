// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Home Page
 *
 * Redirects authenticated users to the project workspace home.
 * Falls back to the main chat layout for unauthenticated visitors.
 */

'use client'

import { type ReactNode, Suspense, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/adapters/auth'
import { MainLayout } from '@/features/layout'

const HomeContent = (): ReactNode => {
  const { isAuthenticated, signIn, isLoading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      router.replace('/projects')
    }
  }, [isAuthenticated, isLoading, router])

  if (isAuthenticated) {
    return null
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
    <Suspense fallback={null}>
      <HomeContent />
    </Suspense>
  )
}

export default HomePage
