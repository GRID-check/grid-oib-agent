/**
 * BYOK LLM provider presets (ADR-0022).
 *
 * Every provider must expose an OpenAI-compatible API — the backend's LLM
 * clients are `_type: openai` (ADR-0010), so the credential swap only changes
 * `api_key`/`base_url`, never the wire protocol. `custom` covers self-hosted
 * gateways (LiteLLM, Azure APIM, corporate proxies).
 */

export const LLM_CREDENTIAL_PROVIDERS = ['openrouter', 'openai', 'azure-openai', 'custom'] as const
export type LlmCredentialProvider = (typeof LLM_CREDENTIAL_PROVIDERS)[number]

interface ProviderPreset {
  /** Default OpenAI-compatible base URL; null = admin MUST supply one. */
  defaultBaseUrl: string | null
  /** Whether a custom base URL may be supplied at all. */
  allowsCustomBaseUrl: boolean
}

const PRESETS: Record<LlmCredentialProvider, ProviderPreset> = {
  openrouter: { defaultBaseUrl: 'https://openrouter.ai/api/v1', allowsCustomBaseUrl: false },
  openai: { defaultBaseUrl: 'https://api.openai.com/v1', allowsCustomBaseUrl: false },
  // Azure's OpenAI-compatible endpoint is per-resource — always tenant-supplied.
  'azure-openai': { defaultBaseUrl: null, allowsCustomBaseUrl: true },
  custom: { defaultBaseUrl: null, allowsCustomBaseUrl: true },
}

export function isKnownProvider(value: string): value is LlmCredentialProvider {
  return (LLM_CREDENTIAL_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Resolve the effective base URL for a provider + optional admin-supplied
 * URL. Throws `Error` with a human message on invalid combinations — the
 * service maps it to a 400/422.
 */
export function resolveBaseUrl(provider: LlmCredentialProvider, baseUrl: string | null | undefined): string {
  const preset = PRESETS[provider]
  const supplied = baseUrl?.trim() || null
  if (supplied && !preset.allowsCustomBaseUrl) {
    throw new Error(`Provider "${provider}" uses its fixed endpoint; a custom base URL is not allowed`)
  }
  const effective = supplied ?? preset.defaultBaseUrl
  if (!effective) {
    throw new Error(`Provider "${provider}" requires a base URL`)
  }
  return effective.replace(/\/+$/, '')
}

/** Hosts that are never a legitimate LLM endpoint from this deployment. */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?fd[0-9a-f]{2}:/i,
  /\.(local|internal|localdomain)$/i,
]

/**
 * SSRF guard for tenant-supplied base URLs (ADR-0022): HTTPS only, no
 * loopback/link-local/RFC-1918 hosts. Deployments fronting a self-hosted
 * internal gateway can opt out via GRID_BYOK_ALLOW_PRIVATE_BASE_URLS=true.
 * Throws `Error` with a human message when the URL is rejected.
 */
export function assertSafeBaseUrl(effectiveBaseUrl: string): void {
  let url: URL
  try {
    url = new URL(effectiveBaseUrl)
  } catch {
    throw new Error('Base URL is not a valid URL')
  }
  if (url.protocol !== 'https:') {
    throw new Error('Base URL must use HTTPS')
  }
  if (url.username || url.password) {
    throw new Error('Base URL must not embed credentials')
  }
  const allowPrivate = (process.env.GRID_BYOK_ALLOW_PRIVATE_BASE_URLS ?? '').toLowerCase() === 'true'
  if (allowPrivate) return
  const host = url.hostname
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new Error('Base URL points at a private or local network address')
  }
}
