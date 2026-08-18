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
import { type Metadata, type Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { connection } from 'next/server'
import { ChunkReloadGuard } from './chunk-reload-guard'
import { Providers } from './providers'
import { NavigationTrail } from '@/components/shell/navigation-trail'
import type { AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { isVlmConfigured } from '@/lib/documents/vlm-capability'
import { getGridSession } from '@/lib/auth/session'
import { runWithTenantSlot } from '@/lib/db/tenant-context'
import { PRODUCT_NAME } from '@/lib/brand'
import {
  FEATURE_FLAGS,
  isFeatureEnabled,
  isIfcModelsEnabled,
  type KnownFeatureFlag,
} from '@/lib/authz/feature-flags'
import { getLocale } from '@/i18n/server'
import { getDictionary } from '@/i18n'
import './globals.css'
import { isAuthRequired } from '@/lib/auth/auth-required'

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
  display: 'swap',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
})

/**
 * Mobile-first viewport: edge-to-edge rendering on notched devices
 * (safe-area insets are handled per-surface with env() padding).
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export const metadata: Metadata = {
  title: {
    // Bare landing/auth routes render this; nested routes (e.g. a project)
    // override `template` so their titles read "<Section> — Piloti".
    default: `${PRODUCT_NAME} — OIB Compliance Assistant`,
    template: `%s — ${PRODUCT_NAME}`,
  },
  description:
    'AI compliance assistant for Austrian building regulations (OIB Richtlinien) — searches, interprets, and cites building-code requirements.',
  icons: {
    icon: '/favicon.ico',
  },
}

/**
 * Whether standalone image upload is offered to this session (WorkOS
 * `image-upload` flag, FB-15a). Read tolerantly — an unauthenticated route or a
 * session-lookup failure must never break the layout; it just falls back to the
 * flag's default (fail-open when enforcement is off, so images are offered).
 */
const isImageUploadEnabled = async (): Promise<boolean> =>
  isSessionFlagEnabled(FEATURE_FLAGS.imageUpload)

/**
 * Whether IFC model upload is offered to this session (WorkOS `ifc-models`).
 *
 * Read through `isIfcModelsEnabled`, not the flag directly: this feature is
 * dark-launched, so with enforcement off it needs `GRID_IFC_MODELS_ENABLED`
 * rather than falling open like the cosmetic flags do.
 */
const isIfcUploadEnabled = async (): Promise<boolean> => {
  try {
    return await runWithTenantSlot(async () => {
      const session = await getGridSession()
      return isIfcModelsEnabled(session ?? { featureFlags: null })
    })
  } catch {
    return isIfcModelsEnabled({ featureFlags: null })
  }
}

const isSessionFlagEnabled = async (flag: KnownFeatureFlag): Promise<boolean> => {
  try {
    // Own slot, like every other entry point: the root layout gets no route
    // factory either, and `getGridSession` publishes the tenant into whatever
    // slot is open — with none, into an ambient binding that does not survive.
    return await runWithTenantSlot(async () => {
      const session = await getGridSession()
      if (!session) return isFeatureEnabled({ featureFlags: null }, flag)
      return isFeatureEnabled(session, flag)
    })
  } catch {
    return isFeatureEnabled({ featureFlags: null }, flag)
  }
}

/**
 * Runtime configuration from server-side environment variables.
 * These values can be changed at runtime without rebuilding the container.
 */
const getAppConfig = async (): Promise<AppConfig> => {
  // Image upload = flag AND capability; IFC upload = flag alone (extraction runs
  // in this process, so there is no capability to derive). Resolved server-side
  // so the picker and validation share ONE accepted-types list with the upload
  // allow-list.
  const [imageUploadEnabled, vlmAvailable, ifcUploadEnabled] = await Promise.all([
    isImageUploadEnabled(),
    isVlmConfigured(),
    isIfcUploadEnabled(),
  ])
  return {
    authRequired: isAuthRequired(),
    fileUpload: getFileUploadConfigFromEnv(process.env, {
      imageUploadEnabled,
      vlmAvailable,
      ifcUploadEnabled,
    }),
  }
}

interface RootLayoutProps {
  children: ReactNode
}

const RootLayout = async ({ children }: RootLayoutProps): Promise<ReactNode> => {
  await connection()
  const config = await getAppConfig()
  const locale = await getLocale()
  const t = getDictionary(locale).common

  return (
    <html
      lang={locale}
      id="style-root"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="bg-surface-base text-foreground font-sans antialiased">
        <ChunkReloadGuard />
        <a
          href="#main-content"
          className="focus-visible:z-skip-link focus-visible:bg-primary focus-visible:text-primary-foreground sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3 focus-visible:rounded-full focus-visible:px-4 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:shadow-md"
        >
          {t.actions.skipToContent}
        </a>
        <Providers config={config} locale={locale}>
          {/* Records where the reader has been, so the pages outside the project
              shell can offer a back control that actually goes back. */}
          <NavigationTrail />
          {children}
        </Providers>
      </body>
    </html>
  )
}

export default RootLayout
