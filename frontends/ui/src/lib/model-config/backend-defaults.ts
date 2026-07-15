/**
 * Workflow-default model names, resolved from the Python backend.
 *
 * The backend exposes its loaded `llms:` block via
 * `GET /v1/config/llm-defaults` (internal-token guarded). Mapped through each
 * agent group's `configLlmRefs`, this tells the admin UI what "workflow
 * default" actually means per group — and what a reset returns to.
 *
 * Best-effort with a 5-minute cache (the config only changes on backend
 * restart): a failure yields nulls, never an error — the UI then shows the
 * generic "workflow default" label.
 */

import 'server-only'
import { AGENT_GROUPS } from './agent-groups'

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

/** `{agentGroupId: defaultModelId | null}` — null when unresolvable. */
export async function getGroupDefaults(): Promise<GroupDefaults> {
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

/** Test hook. */
export function _clearDefaultsCache(): void {
  cache = null
}
