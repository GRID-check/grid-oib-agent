'use client'

/**
 * Dev preview for the platform default-model surface. Renders the REAL card
 * with fixture data so the three states that matter can be reviewed and
 * screenshotted without a backend or an OpenRouter key:
 *
 *  - a group pinned to a platform default (`shallow_research`, `intent`),
 *  - a group still on the workflow config (`clarifier`, `deep_research`, …),
 *  - a pinned default with no zero-data-retention endpoint (`deep_research_router`),
 *    which ZDR tenants cannot inherit,
 *  - the thinking level on the same rows: pinned at both ends of the scale and
 *    inheriting the concrete workflow level everywhere else.
 *
 * A module-scope fetch shim (browser + dev only) serves the defaults payload
 * and the picker search. Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { PlatformModelDefaults } from '@/app/app/(shell)/platform/models/platform-model-defaults'
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

const WORKFLOW_DEFAULTS = Object.fromEntries(AGENT_GROUPS.map((group) => [group.id, 'openai/gpt-5.6-luna']))

// The thinking-level half of the same card. Pinned at both ends of the scale
// (`intent` → none, `deep_research` → xhigh) so the cheapest and most expensive
// labels are both on screen; the rest inherit.
const EFFORTS = {
  intent: { effort: 'none', updatedByEmail: 'owner@grid.example', updatedAt: '2026-08-01T09:00:00Z' },
  deep_research: { effort: 'xhigh', updatedByEmail: 'owner@grid.example', updatedAt: '2026-08-01T09:00:00Z' },
}

// Mirrors the shipped config: routing roles run reasoning-off, everything else
// medium. `ingest_vlm` is deliberately null — the backend reports no YAML effort
// for the env-configured VLM, and the option must degrade to the generic label
// instead of inventing one.
const WORKFLOW_EFFORTS: Record<string, string | null> = {
  intent: 'none',
  clarifier: 'medium',
  shallow_research: 'low',
  deep_research: 'medium',
  deep_research_router: 'none',
  memory_reflection: 'medium',
  ingest_vlm: null,
}

const CATALOG = [
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', contextLength: 200000, promptPrice: 0.000003, completionPrice: 0.000015, zdrSafe: true },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextLength: 163840, promptPrice: 0.00000027, completionPrice: 0.0000011, zdrSafe: true },
  { id: 'vendor/router-mini', name: 'Router Mini', contextLength: 65536, promptPrice: 0.0000001, completionPrice: 0.0000004, zdrSafe: false },
]

const PREVIEW_PATH = '/dev/platform-models'

/**
 * Install the fixture responder. Installed ONCE at module scope and never torn
 * down — scope is controlled by the pathname check inside, not by a lifecycle.
 *
 * Both halves of that are load-bearing, and the obvious alternative is broken:
 *
 *  - Module scope, not an effect. The card fetches from an effect of its own,
 *    and a child's effects run BEFORE its parent's, so a shim armed on mount
 *    arrives after the first request has already left for the real API.
 *  - No teardown on unmount. Under React's StrictMode double-invoke (dev only),
 *    a remount runs cleanups child→parent and then effects child→parent — so a
 *    parent cleanup that restores `window.fetch` does it EXACTLY between the
 *    child's two fetch attempts, and the second one escapes to the real API.
 *    That is not a hypothetical: this preview (and its screenshots) rendered
 *    the error state for exactly this reason while the install flag read `true`.
 *
 * Leaving the patch installed is safe because it answers only while the preview
 * is the page on screen; a client navigation to the real platform surface takes
 * the `real` branch on every request.
 */
function installShim(): void {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') return
  const w = window as unknown as { __platformModelDefaultsShim?: boolean }
  if (w.__platformModelDefaultsShim) return
  w.__platformModelDefaultsShim = true
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (window.location.pathname.startsWith(PREVIEW_PATH)) {
      if (url.includes('/api/platform/model-defaults/models')) {
        return Response.json({ group: 'preview', models: CATALOG })
      }
      if (url.includes('/api/platform/model-defaults')) {
        return Response.json({ agentGroups: AGENT_GROUPS, defaults: DEFAULTS, workflowDefaults: WORKFLOW_DEFAULTS })
      }
      if (url.includes('/api/platform/reasoning-efforts')) {
        return Response.json({ efforts: EFFORTS, workflowEfforts: WORKFLOW_EFFORTS })
      }
    }
    return real(input, init)
  }
}

installShim()

export default function PlatformModelsDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8" data-testid="platform-models-preview">
      <div>
        <h1 className="text-lg font-semibold">Platform — Default models and thinking levels</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Platform-owner surface: the model each agent group runs on, and how hard it thinks, for every
          organization that has not chosen its own.
        </p>
      </div>
      <PlatformModelDefaults />
    </main>
  )
}
