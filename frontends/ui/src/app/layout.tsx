// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Root Layout
 *
 * The root layout for the entire application.
 * Sets up the HTML structure, global styles, and providers.
 *
 * Server-side environment variables are read here and passed to client
 * providers, enabling runtime configuration without rebuilding.
 */

import { type ReactNode } from 'react'
import { type Metadata } from 'next'
import { connection } from 'next/server'
import { Providers } from './providers'
import type { AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import './globals.css'

const isAuthRequired = (): boolean => {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

export const metadata: Metadata = {
  title: 'Grid',
  description: 'AI-powered research assistant',
  icons: {
    icon: '/favicon.ico',
  },
}

/**
 * Runtime configuration from server-side environment variables.
 * These values can be changed at runtime without rebuilding the container.
 */
const getAppConfig = (): AppConfig => ({
  authRequired: isAuthRequired(),
  fileUpload: getFileUploadConfigFromEnv(process.env),
})

interface RootLayoutProps {
  children: ReactNode
}

const RootLayout = async ({ children }: RootLayoutProps): Promise<ReactNode> => {
  await connection()
  const config = getAppConfig()

  return (
    <html lang="en" id="style-root" suppressHydrationWarning>
      <body className="bg-surface-base">
        <Providers config={config}>{children}</Providers>
      </body>
    </html>
  )
}

export default RootLayout
