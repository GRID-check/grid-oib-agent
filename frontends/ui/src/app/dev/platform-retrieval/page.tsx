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

import { useEffect } from 'react'
import { notFound } from 'next/navigation'
import { PlatformRetrievalSettings } from '@/app/app/platform/retrieval/platform-retrieval-settings'
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

/** Install the fixture responder; returns the undo, or undefined if not needed. */
function installShim(): (() => void) | undefined {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') return undefined
  const w = window as unknown as { __platformRetrievalSettingsShim?: boolean }
  if (w.__platformRetrievalSettingsShim) return undefined
  w.__platformRetrievalSettingsShim = true
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('/api/platform/retrieval-settings')) {
      return Response.json({ definitions: DEFINITIONS, settings: SETTINGS })
    }
    return real(input, init)
  }
  return () => {
    window.fetch = real
    w.__platformRetrievalSettingsShim = false
  }
}

// Installed at module scope rather than from the page's effect: the card fetches
// from an effect of its own, and a child's effects run BEFORE the parent's, so a
// shim armed on mount would arrive after the first request had already left for
// the real API. The page still tears it down on unmount (below) so a client
// navigation away from the preview does not leave `window.fetch` patched for
// the rest of the session.
let uninstallShim = installShim()

export default function PlatformRetrievalDevPage(): JSX.Element {
  useEffect(() => {
    // Re-arm when returning to the preview after a previous unmount tore it down.
    uninstallShim ??= installShim()
    return () => {
      uninstallShim?.()
      uninstallShim = undefined
    }
  }, [])

  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8" data-testid="platform-retrieval-preview">
      <div>
        <h1 className="text-lg font-semibold">Platform — Retrieval</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Platform-owner surface: how many chunks and results each retrieval tool fetches per query, for every organization at once.
        </p>
      </div>
      <PlatformRetrievalSettings />
    </main>
  )
}
