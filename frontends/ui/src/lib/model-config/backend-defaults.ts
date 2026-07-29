/**
 * What a group falls back to when an organization has NOT chosen a model.
 *
 * Two layers, and the admin UI cares about both:
 *
 *  - `getWorkflowGroupDefaults()` — the models in the backend's loaded `llms:`
 *    block, from `GET /v1/config/llm-defaults` (internal-token guarded), mapped
 *    through each group's `configLlmRefs`. This is the boot fallback: what runs
 *    when nothing has ever been configured anywhere.
 *  - `getGroupDefaults()` — the same, with the platform owner's
 *    `platform_model_defaults` layered on top. This is what a tenant actually
 *    inherits, so it is the number the org settings screen must show as "the
 *    default" and what a per-group reset returns to.
 *
 * Best-effort with a 5-minute cache (the YAML only changes on backend restart):
 * a failure yields nulls, never an error — the UI then shows the generic
 * "default" label.
 */

import 'server-only'
import { AGENT_GROUPS } from './agent-groups'
import { getPlatformModelDefaults } from './platform-defaults'

export type GroupDefaults = Record<string, string | null>

const CACHE_TTL_MS = 5 * 60 * 1000

// Fail-open label resolution: bound the backend call so an unreachable backend
// falls through to the generic "workflow default" label instead of hanging.
const LLM_DEFAULTS_TIMEOUT_MS = 10_000

let cache: { fetchedAt: number; llms: Record<string, string | null> } | null = null

async function fetchLlmDefaults(): Promise<Record<string, string | null>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.llms
  }
  const base = (process.env.BACKEND_URL ?? 'http://localhost:8000').replace(/\/$/, '')
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = process.env.GRID_INTERNAL_API_TOKEN
  if (token) headers['x-grid-internal-token'] = token

  const response = await fetch(`${base}/v1/config/llm-defaults`, {
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(LLM_DEFAULTS_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`llm-defaults request failed: HTTP ${response.status}`)
  }
  const body = (await response.json()) as { llms?: Record<string, string | null> }
  const llms = body.llms ?? {}
  cache = { fetchedAt: Date.now(), llms }
  return llms
}

/**
 * `{agentGroupId: yamlModelId | null}` — the backend's YAML models, null when
 * unresolvable. The boot fallback layer only; most callers want
 * `getGroupDefaults()`.
 */
export async function getWorkflowGroupDefaults(): Promise<GroupDefaults> {
  const defaults: GroupDefaults = Object.fromEntries(AGENT_GROUPS.map((group) => [group.id, null]))
  try {
    const llms = await fetchLlmDefaults()
    for (const group of AGENT_GROUPS) {
      const models = [
        ...new Set(group.configLlmRefs.map((ref) => llms[ref]).filter((m): m is string => typeof m === 'string')),
      ]
      // Groups spanning several config LLMs (deep research) normally share one
      // model; if they ever diverge, show them all.
      defaults[group.id] = models.length > 0 ? models.join(', ') : null
    }
  } catch (error) {
    console.warn('[Model Config] Could not resolve workflow-default models from backend:', error)
  }
  return defaults
}

/**
 * `{agentGroupId: effectiveDefaultModelId | null}` — what an org that has made
 * no choice of its own actually runs: the platform default where the owner set
 * one, the YAML model otherwise.
 *
 * Fails open per layer: an unreachable backend still shows the platform
 * defaults, an unreadable defaults table still shows the YAML models.
 */
export async function getGroupDefaults(): Promise<GroupDefaults> {
  const [workflowDefaults, platformDefaults] = await Promise.all([
    getWorkflowGroupDefaults(),
    getPlatformModelDefaults().catch((error) => {
      console.warn('[Model Config] Could not resolve platform model defaults:', error)
      return {} as Record<string, string>
    }),
  ])
  const defaults: GroupDefaults = { ...workflowDefaults }
  for (const [groupId, model] of Object.entries(platformDefaults)) {
    defaults[groupId] = model
  }
  return defaults
}

/** Test hook. */
export function _clearDefaultsCache(): void {
  cache = null
}
