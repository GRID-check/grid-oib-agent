'use client'

/**
 * Dev preview for the platform retrieval-settings surface. Renders the REAL
 * card with fixture data so the two states that matter can be reviewed and
 * screenshotted without a backend:
 *
 *  - a count pinned to a platform value (`knowledge.top_k`, `web.max_results`),
 *  - a count still on the build-time config default (everything else).
 *
 * A module-scope fetch shim (browser + dev only) serves the settings payload.
 * Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { PlatformRetrievalSettings } from '@/app/app/(shell)/platform/retrieval/platform-retrieval-settings'
import { PageHeader } from '@/components/ui/page-header'
import { useTranslations } from '@/i18n'
import { RETRIEVAL_SETTINGS } from '@/lib/retrieval-settings/catalog'

// The real catalog, not a copy of it: a renamed key or a reworded description
// should show up in this preview (and its screenshots) instead of quietly
// drifting from what the surface actually renders.
const DEFINITIONS = RETRIEVAL_SETTINGS

interface SettingFixture {
  key: string
  value: number
  defaultValue: number
  overridden: boolean
  updatedByEmail: string | null
  updatedAt: string | null
  note: string | null
}

const PINNED: Record<string, { value: number; note: string }> = {
  'knowledge.top_k': { value: 20, note: 'mehr Kontext für Querschnittsfragen' },
  'web.max_results': { value: 10, note: 'breitere Websuche' },
}

const SETTINGS: SettingFixture[] = DEFINITIONS.map((definition) => {
  const pinned = PINNED[definition.key]
  return {
    key: definition.key,
    value: pinned?.value ?? definition.defaultValue,
    defaultValue: definition.defaultValue,
    overridden: pinned !== undefined,
    note: pinned?.note ?? null,
    updatedByEmail: pinned ? 'owner@grid.example' : null,
    updatedAt: pinned ? '2026-07-28T09:00:00Z' : null,
  }
})

const PREVIEW_PATH = '/dev/platform-retrieval'

/**
 * Install the fixture responder ONCE at module scope and never tear it down;
 * scope comes from the pathname check inside. A teardown on unmount restores
 * `window.fetch` between StrictMode's two mounts, so the card's second fetch
 * escaped to the real API and the preview showed the error state.
 */
function installShim(): void {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') return
  const w = window as unknown as { __platformRetrievalSettingsShim?: boolean }
  if (w.__platformRetrievalSettingsShim) return
  w.__platformRetrievalSettingsShim = true
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (
      window.location.pathname.startsWith(PREVIEW_PATH) &&
      url.startsWith('/api/platform/retrieval-settings')
    ) {
      if (init?.method === 'PUT') return Response.json({ ok: true })
      return Response.json({ definitions: DEFINITIONS, settings: SETTINGS })
    }
    return real(input, init)
  }
}

installShim()

export default function PlatformRetrievalDevPage(): JSX.Element {
  const t = useTranslations('platform')
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main
      className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8 md:px-8"
      data-testid="platform-retrieval-preview"
    >
      <PageHeader
        title={t('sections.retrieval.title')}
        subtitle={t('sections.retrieval.subtitle')}
      />
      <PlatformRetrievalSettings />
    </main>
  )
}
