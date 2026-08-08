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

/** `{configLlmName: baseUrl | null}` — the endpoint each workflow LLM targets. */
export type LlmBaseUrls = Record<string, string | null>

interface LlmDefaults {
  llms: Record<string, string | null>
  baseUrls: LlmBaseUrls
  reasoningEfforts: Record<string, string | null>
}

/**
 * Whether the shared internal token may travel to `baseUrl`.
 *
 * HTTPS always qualifies. Plain HTTP qualifies only for destinations that cannot
 * leave the deployment's own network: loopback, an RFC1918/link-local/CGNAT
 * address, `.internal`/`.local`, or a single-label hostname — which is what a
 * compose service name (`aiq-agent`) or a Kubernetes short name looks like.
 * Anything else is a public host over cleartext and does not get the secret.
 */
export function isTokenSafeDestination(baseUrl: string): boolean {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true
  if (host.endsWith('.internal') || host.endsWith('.local')) return true
  // No dot and no colon: a container/service short name, resolvable only inside
  // the deployment's own network.
  if (!host.includes('.') && !host.includes(':')) return true

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true
  return false
}

let cache: { fetchedAt: number; defaults: LlmDefaults } | null = null

async function fetchLlmDefaults(): Promise<LlmDefaults> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.defaults
  }
  const base = (process.env.BACKEND_URL ?? 'http://localhost:8000').replace(/\/$/, '')
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = process.env.GRID_INTERNAL_API_TOKEN
  // The shared internal token is a bearer secret. Plain HTTP is the NORMAL and
  // intended transport here — the backend is a sibling service on the compose or
  // cluster network (`http://aiq-agent:8000`), which is isolated and has no TLS
  // terminator — so HTTP is not by itself a reason to withhold it. What must not
  // happen is sending it somewhere that is neither TLS-protected nor demonstrably
  // on that internal network, so an operator who points BACKEND_URL at a public
  // http:// host gets the request without the token (and a loud warning) rather
  // than a secret in cleartext across the internet.
  if (token) {
    if (isTokenSafeDestination(base)) {
      headers['x-grid-internal-token'] = token
    } else {
      console.warn(
        `[Model Config] Withholding the internal token: BACKEND_URL (${base}) is plain HTTP to a non-internal host. Use https, or an internal hostname/private address.`
      )
    }
  }

  const response = await fetch(`${base}/v1/config/llm-defaults`, {
    headers,
    cache: 'no-store',
    // A redirect would replay the token at whatever host the response names, so
    // it is an error rather than something to follow. The internal endpoint
    // never redirects; if it starts to, that is a misconfiguration to see.
    redirect: 'error',
    signal: AbortSignal.timeout(LLM_DEFAULTS_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`llm-defaults request failed: HTTP ${response.status}`)
  }
  const body = (await response.json()) as {
    llms?: Record<string, string | null>
    baseUrls?: LlmBaseUrls
    reasoningEfforts?: Record<string, string | null>
  }
  // `baseUrls` is absent when the BFF is newer than the backend (rolling
  // deploy). An empty map means "endpoint unknown", which the seeding path
  // treats as "do not seed" rather than "assume OpenRouter".
  const defaults: LlmDefaults = {
    llms: body.llms ?? {},
    baseUrls: body.baseUrls ?? {},
    reasoningEfforts: body.reasoningEfforts ?? {},
  }
  cache = { fetchedAt: Date.now(), defaults }
  return defaults
}

/**
 * `{configLlmName: baseUrl | null}` for the backend's loaded `llms:` block,
 * plus the synthetic `vlm` key. Throws when the backend is unreachable — the
 * seeding caller must be able to tell "not OpenRouter" from "could not ask".
 */
export async function getWorkflowLlmBaseUrls(): Promise<LlmBaseUrls> {
  const { baseUrls } = await fetchLlmDefaults()
  return baseUrls
}

/**
 * `{agentGroupId: yamlReasoningEffort | null}` — what each group's role ships
 * with in the workflow config, so the platform surface can name what clearing
 * an effort returns to. Best-effort: an unreachable backend yields nulls.
 *
 * A group spanning several config LLMs (deep research) normally shares one
 * effort; if they ever diverge, all of them are shown, mirroring
 * `getWorkflowGroupDefaults`.
 */
export async function getWorkflowGroupReasoningEfforts(): Promise<GroupDefaults> {
  const efforts: GroupDefaults = Object.fromEntries(AGENT_GROUPS.map((group) => [group.id, null]))
  try {
    const { reasoningEfforts } = await fetchLlmDefaults()
    for (const group of AGENT_GROUPS) {
      const values = [
        ...new Set(
          group.configLlmRefs
            .map((ref) => reasoningEfforts[ref])
            .filter((value): value is string => typeof value === 'string'),
        ),
      ]
      efforts[group.id] = values.length > 0 ? values.join(', ') : null
    }
  } catch (error) {
    console.warn('[Model Config] Could not resolve workflow reasoning efforts from backend:', error)
  }
  return efforts
}

/**
 * `{agentGroupId: yamlModelId | null}` — the backend's YAML models, null when
 * unresolvable. The boot fallback layer only; most callers want
 * `getGroupDefaults()`.
 */
export async function getWorkflowGroupDefaults(): Promise<GroupDefaults> {
  const defaults: GroupDefaults = Object.fromEntries(AGENT_GROUPS.map((group) => [group.id, null]))
  try {
    const { llms } = await fetchLlmDefaults()
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
