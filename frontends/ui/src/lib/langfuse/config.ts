/**
 * Where Langfuse is, as far as the BFF is concerned: the API it writes scores
 * to, and the UI a platform owner is sent to (ADR-0044, Amendment 3).
 *
 * Two different addresses on purpose. The API is reached in-cluster
 * (`http://langfuse-web:3000`), the same Service the collector exports to; the
 * UI is the public, SSO-gated host a browser opens (`https://langfuse.<domain>`).
 * Pointing either at the other breaks something quietly: the BFF cannot pass
 * the edge's OIDC gate, and a browser cannot resolve a cluster Service name.
 *
 * Availability is capability only, read per call: with any part missing the
 * caller gets `null` and does nothing. In particular there is NO default host.
 * The Langfuse SDK's own default is Langfuse Cloud, and a deployment with keys
 * but no host would otherwise send every vote, with its comment, to a third
 * party, which is the one thing ADR-0044 decided against.
 */

import 'server-only'

export interface LangfuseApiConfig {
  publicKey: string
  secretKey: string
  /** Base URL of the Langfuse API, e.g. `http://langfuse-web:3000`. No trailing slash. */
  baseUrl: string
}

export interface LangfuseUiConfig {
  /** Browser-facing origin of the Langfuse UI. No trailing slash. */
  publicUrl: string
  projectId: string
}

const env = (name: string): string | null => {
  const value = process.env[name]?.trim()
  return value ? value : null
}

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, '')

/** The API credentials and host, or null when scoring is not configured. */
export function langfuseApiConfig(): LangfuseApiConfig | null {
  const publicKey = env('LANGFUSE_PUBLIC_KEY')
  const secretKey = env('LANGFUSE_SECRET_KEY')
  const baseUrl = env('LANGFUSE_HOST')
  if (!publicKey || !secretKey || !baseUrl) return null
  return { publicKey, secretKey, baseUrl: withoutTrailingSlash(baseUrl) }
}

/** The UI origin and project, or null when deep links are not configured. */
export function langfuseUiConfig(): LangfuseUiConfig | null {
  const publicUrl = env('LANGFUSE_PUBLIC_URL')
  const projectId = env('LANGFUSE_PROJECT_ID')
  if (!publicUrl || !projectId) return null
  return { publicUrl: withoutTrailingSlash(publicUrl), projectId }
}

/** An OTel/Langfuse trace id: 32 lowercase hex digits, as the agent writes it. */
const TRACE_ID = /^[0-9a-f]{32}$/

export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID.test(value)
}

/** The project's page in the Langfuse UI (its scores live under it), or null. */
export function langfuseProjectUrl(ui: LangfuseUiConfig | null = langfuseUiConfig()): string | null {
  if (!ui) return null
  return `${ui.publicUrl}/project/${encodeURIComponent(ui.projectId)}`
}

/**
 * One trace's page in the Langfuse UI, or null when links are not configured or
 * the id is not a trace id. The path is the one Langfuse's own SDK builds
 * (`LangfuseClient.getTraceUrl`: `/project/<id>/traces/<traceId>`).
 */
export function langfuseTraceUrl(
  traceId: string | null | undefined,
  ui: LangfuseUiConfig | null = langfuseUiConfig()
): string | null {
  const project = langfuseProjectUrl(ui)
  if (!project || !isTraceId(traceId)) return null
  return `${project}/traces/${traceId}`
}
