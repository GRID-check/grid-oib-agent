'use client'

/**
 * Dev preview for the platform default-model surface. Renders the REAL card
 * with fixture data so the three states that matter can be reviewed and
 * screenshotted without a backend or an OpenRouter key:
 *
 *  - a group pinned to a platform default (`shallow_research`, `intent`),
 *  - a group still on the workflow config (`clarifier`, `deep_research`, …),
 *  - a pinned default with no zero-data-retention endpoint (`deep_research_router`),
 *    which ZDR tenants cannot inherit.
 *
 * A module-scope fetch shim (browser + dev only) serves the defaults payload
 * and the picker search. Not linked from anywhere and 404s outside development.
 */

import { useEffect } from 'react'
import { notFound } from 'next/navigation'
import { PlatformModelDefaults } from '@/app/app/platform/models/platform-model-defaults'
import { AGENT_GROUPS as REGISTRY } from '@/lib/model-config/agent-groups'

// The real registry, not a copy of it: a renamed group or a reworded
// description should show up in this preview (and its screenshots) instead of
// quietly drifting from what the surface actually renders.
const AGENT_GROUPS = REGISTRY.map(({ id, label, description }) => ({ id, label, description }))

const DEFAULTS = {
  intent: {
    model: 'deepseek/deepseek-v4-flash',
    updatedByEmail: 'owner@grid.example',
    updatedAt: '2026-07-28T09:00:00Z',
    zdrSafe: true,
  },
  shallow_research: {
    model: 'anthropic/claude-sonnet-5',
    updatedByEmail: 'owner@grid.example',
    updatedAt: '2026-07-28T09:00:00Z',
    zdrSafe: true,
  },
  deep_research_router: {
    model: 'vendor/router-mini',
    updatedByEmail: 'owner@grid.example',
    updatedAt: '2026-07-28T09:00:00Z',
    zdrSafe: false,
  },
}

const WORKFLOW_DEFAULTS = Object.fromEntries(AGENT_GROUPS.map((group) => [group.id, 'deepseek/deepseek-v4-flash']))

const CATALOG = [
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', contextLength: 200000, promptPrice: 0.000003, completionPrice: 0.000015, zdrSafe: true },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextLength: 163840, promptPrice: 0.00000027, completionPrice: 0.0000011, zdrSafe: true },
  { id: 'vendor/router-mini', name: 'Router Mini', contextLength: 65536, promptPrice: 0.0000001, completionPrice: 0.0000004, zdrSafe: false },
]

/** Install the fixture responder; returns the undo, or undefined if not needed. */
function installShim(): (() => void) | undefined {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') return undefined
  const w = window as unknown as { __platformModelDefaultsShim?: boolean }
  if (w.__platformModelDefaultsShim) return undefined
  w.__platformModelDefaultsShim = true
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('/api/platform/model-defaults/models')) {
      return Response.json({ group: 'preview', models: CATALOG })
    }
    if (url.startsWith('/api/platform/model-defaults')) {
      return Response.json({ agentGroups: AGENT_GROUPS, defaults: DEFAULTS, workflowDefaults: WORKFLOW_DEFAULTS })
    }
    return real(input, init)
  }
  return () => {
    window.fetch = real
    w.__platformModelDefaultsShim = false
  }
}

// Installed at module scope rather than from the page's effect: the card fetches
// from an effect of its own, and a child's effects run BEFORE the parent's, so a
// shim armed on mount would arrive after the first request had already left for
// the real API. The page still tears it down on unmount (below) so a client
// navigation away from the preview does not leave `window.fetch` patched for
// the rest of the session.
let uninstallShim = installShim()

export default function PlatformModelsDevPage(): JSX.Element {
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
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8" data-testid="platform-models-preview">
      <div>
        <h1 className="text-lg font-semibold">Platform — Default models</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Platform-owner surface: the model each agent group runs on for every organization that has not chosen its own.
        </p>
      </div>
      <PlatformModelDefaults />
    </main>
  )
}
