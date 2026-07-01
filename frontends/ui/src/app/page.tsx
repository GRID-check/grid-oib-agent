// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Home Page
 *
 * Main chat interface using the MainLayout component.
 * Displays the full Grid experience.
 * Chat state is managed via the useChatStore.
 */

'use client'

import { type ReactNode, Suspense } from 'react'
import { useAuth } from '@/adapters/auth'
import { MainLayout } from '@/features/layout'

const HomeContent = (): ReactNode => {
  const { isAuthenticated, signIn } = useAuth()

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
