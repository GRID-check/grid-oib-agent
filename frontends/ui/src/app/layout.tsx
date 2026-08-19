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
import localFont from 'next/font/local'
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

/**
 * THE FOUR FACES ARE THE MARKETING SITE'S FOUR FACES.
 *
 * These are byte-identical copies of the woff2 files `frontends/web` serves
 * (Inter, Archivo, Poppins, IBM Plex Mono — all SIL OFL 1.1), not lookalikes
 * fetched separately: an architect who reads piloti.at and then opens the app
 * should not be able to tell that two teams built them. Self-hosted through
 * `next/font/local` rather than `next/font/google`, for the same reason the
 * site self-hosts — no third-party request on first paint, and the file that
 * ships is the file that was reviewed.
 *
 *   serif    Instrument Serif  THE STATEMENT — one moment per surface, ≥24px
 *   display  Archivo/HN        THE WORKING VOICE — titles, headings, eyebrows, stats
 *   sans     Inter             body, controls, everything unmarked
 *   mono     IBM Plex Mono     identifiers — job ids, § refs, collection names
 *   logo     Poppins           the wordmark, and nothing else
 *
 * TWO FACES, TWO JOBS, AND THE SPLIT IS THE POINT. The grotesk is what the
 * product speaks in all day: it is neutral on purpose, it holds at 13px, and a
 * dense compliance UI needs exactly that. The serif is what the BRAND says —
 * the hero on the site, the greeting on an empty thread — and it appears once
 * per surface, at display size, or not at all.
 *
 * Instrument Serif and not a text serif (Spectral was tried and reverted): a
 * text serif blown up to 70px reads as a book paragraph enlarged, which is what
 * made the first attempt look dated. This is a DISPLAY face — condensed, high
 * contrast, drawn for size — the open equivalent of the Domaine/Canela class
 * that premium editorial brands use. The corollary is the hard floor: it has
 * only a 400 weight and it thins out fast, so below ~24px it is never used.
 *
 * `display: 'swap'` throughout: a legal answer that is invisible for 200ms is
 * worse than one that reflows.
 */
const interSans = localFont({
  src: './fonts/inter-var-latin.woff2',
  variable: '--font-inter',
  weight: '400 600',
  display: 'swap',
})

const instrumentSerif = localFont({
  src: [
    { path: './fonts/instrument-serif-400-latin.woff2', weight: '400', style: 'normal' },
    { path: './fonts/instrument-serif-400-italic-latin.woff2', weight: '400', style: 'italic' },
  ],
  variable: '--font-instrument-serif',
  display: 'swap',
})

const archivoDisplay = localFont({
  src: './fonts/archivo-var-latin.woff2',
  variable: '--font-archivo',
  weight: '400 700',
  display: 'swap',
})

const poppinsLogo = localFont({
  src: [
    { path: './fonts/poppins-400-latin.woff2', weight: '400', style: 'normal' },
    { path: './fonts/poppins-500-latin.woff2', weight: '500', style: 'normal' },
    { path: './fonts/poppins-600-latin.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-poppins',
  display: 'swap',
})

const plexMono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-400-latin.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-500-latin.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-plex-mono',
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
      className={`${interSans.variable} ${instrumentSerif.variable} ${archivoDisplay.variable} ${poppinsLogo.variable} ${plexMono.variable}`}
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
